// Swing-catch long-only cbBTC/USDC bot for agent-fun/bars-replay/v1.
//
// Enters after a ≥50 bps drawdown from a 120-bar Donchian peak, once price
// turns back up by ≥8 bps from the zone low. Exits on profit target, hard
// stop, trailing stop, or max hold. Deterministic: no clock/random/env/network.
//
// hello, batch, orders, bar — protocol compliant.

import { createInterface } from 'node:readline';

// ---- parameters ----
const FAST = 5;               // EMA span for trend/momentum
const PEAK_SPAN = 60;         // rolling window for peak price (Donchian high)
const DD_ENTRY_BPS = 50;      // min drawdown from peak to enter the entry zone
const TURN_BPS = 20;          // price must rise this much off zone low to trigger buy
const COST_BPS = 26;          // full round-trip cost estimate
const MIN_VOL_BPS = 1.5;      // per-bar mean abs move below this: too quiet
const MAX_VOL_BPS = 40;       // above this: too wild
const SPIKE_BPS = 200;        // a single-bar move this large skips entry
const TARGET_BPS = 120;       // profit target
const TRAIL_ARM_BPS = 50;     // peak gain at which trailing stop arms
const TRAIL_BPS = 30;         // giveback from peak that triggers trail exit
const STOP_BPS = 80;
const MAX_HOLD = 120;         // max bars to hold a position
const COOLDOWN = 60;          // cooldown after exit
const BASE_WEIGHT = 8500n;    // 0.85 of equity
const MIN_WEIGHT = 5000n;
const MAX_WEIGHT = 10000n;
const DD_GUARD_BPS = 200n;    // drawdown guard halves size
const LOSS_FLOOR_BPS = 300n;  // 3% below start → no new entries
const MAX_SLIP = 100;         // max slippage for orders
const MAX_ORDERS = 16;        // protocol hard limit

// ---- state ----
let hello: any = null;
let startEq = 1000000000n;
let warmup = 0;
let emaF: number | null = null;
const warmF: number[] = [];
const closes: number[] = [];
let vol: number | null = null;
let prev: number | null = null;
let peakEquity = 0n;

// Swing catch state
let inEntryZone = false;
let zoneLow: number | null = null;
let entryPx = 0;
let peakPx = 0;
let heldBars = 0;
let cooldown = 0;
let orderNo = 0;

function emaStep(v: number | null, warm: number[], span: number, x: number): number | null {
  if (v !== null) return v + (2 / (span + 1)) * (x - v);
  warm.push(x);
  if (warm.length === span) return warm.reduce((a, b) => a + b, 0) / span;
  return null;
}

function onBar(c: number): void {
  emaF = emaStep(emaF, warmF, FAST, c);
  if (prev !== null) {
    const r = ((c - prev) / prev) * 10000;
    const a = r < 0 ? -r : r;
    vol = vol === null ? a : vol + (2 / 20) * (a - vol);
  }
  prev = c;
  closes.push(c);
  if (closes.length > PEAK_SPAN + 1) closes.shift();
}

function donchianHigh(n: number = PEAK_SPAN): number | null {
  if (closes.length < n + 1) return null;
  let m = -Infinity;
  for (let i = closes.length - 1 - n; i < closes.length - 1; i++) if (closes[i] > m) m = closes[i];
  return m;
}

function weightBps(equity: bigint): bigint {
  let w = BASE_WEIGHT;
  if (vol !== null && vol > 0) {
    const scaled = Math.floor((Number(BASE_WEIGHT) * 4) / vol);
    w = BigInt(scaled);
  }
  if (w < MIN_WEIGHT) w = MIN_WEIGHT;
  if (w > MAX_WEIGHT) w = MAX_WEIGHT;
  if (peakEquity > 0n && equity * 10000n < peakEquity * (10000n - DD_GUARD_BPS)) w = w / 2n;
  return w;
}

function decide(batch: any): any[] {
  const sym = hello.symbols[0].symbol as string;
  const bar = (batch.bars as any[]).find((b) => b.symbol === sym);
  const acct = batch.account;
  const equity = BigInt(acct.equity_quote_units);
  const cash = BigInt(acct.cash_quote_units);
  if (equity > peakEquity) peakEquity = equity;
  if (bar === undefined) return [];
  const c = Number(bar.c);
  onBar(c);

  if (batch.seq < warmup) return [];
  if (cooldown > 0) cooldown--;

  const pos = (acct.positions as any[]).find((p) => p.symbol === sym);
  const qty = pos ? BigInt(pos.qty) : 0n;

  // ----- Position management -----
  if (qty > 0n) {
    heldBars++;
    if (c > peakPx) peakPx = c;
    const gain = ((c - entryPx) / entryPx) * 10000;
    const peakGain = ((peakPx - entryPx) / entryPx) * 10000;
    const fromPeak = ((peakPx - c) / peakPx) * 10000;
    let exit = false;
    if (gain <= -STOP_BPS) exit = true;
    if (gain >= TARGET_BPS) exit = true;
    if (peakGain >= TRAIL_ARM_BPS && fromPeak >= TRAIL_BPS) exit = true;
    if (heldBars >= MAX_HOLD) exit = true;
    if (exit) {
      inEntryZone = false;
      zoneLow = null;
      return [{ side: 'sell', client_id: `s${orderNo++}`, symbol: sym, qty: qty.toString(), max_slippage_bps: MAX_SLIP }];
    }
    return [];
  }

  // After-exit one-shot reset (entryPx===0 means no prior position to clear)
  if (entryPx !== 0) {
    entryPx = 0;
    peakPx = 0;
    heldBars = 0;
    cooldown = COOLDOWN;
    inEntryZone = false;
    zoneLow = null;
  }

  if (cooldown > 0 || emaF === null || vol === null) return [];
  if (vol < MIN_VOL_BPS || vol > MAX_VOL_BPS) return [];
  if (equity * 10000n < startEq * (10000n - LOSS_FLOOR_BPS)) return [];

  if (prev !== null) {
    const jump = ((c - prev) / prev) * 10000;
    if (jump > SPIKE_BPS || jump < -SPIKE_BPS) return [];
  }

  // ----- Swing catch entry logic -----
  const dh = donchianHigh(PEAK_SPAN);
  if (dh === null) return [];

  const dd = ((dh - c) / dh) * 10000;

  // Enter entry zone when drawdown from peak is deep enough
  if (dd >= DD_ENTRY_BPS && !inEntryZone) {
    inEntryZone = true;
    zoneLow = c;
  }

  // Exit entry zone when price recovers near the peak
  if (dd < 5 && inEntryZone) {
    inEntryZone = false;
    zoneLow = null;
  }

  // Track zone low
  if (inEntryZone && zoneLow !== null && c < zoneLow) {
    zoneLow = c;
  }

  // Entry signal: price turned up by enough from the zone low
  if (inEntryZone && zoneLow !== null) {
    const rise = ((c - zoneLow) / zoneLow) * 10000;
    if (rise >= TURN_BPS) {
      let notional = (equity * weightBps(equity)) / 10000n;
      if (notional > cash) notional = cash;
      if (notional < BigInt(hello.fees.min_notional_quote_units)) return [];
      entryPx = c;
      peakPx = c;
      heldBars = 0;
      // Consume the entry zone so we don't cascade-buy on the same zone
      inEntryZone = false;
      zoneLow = null;
      return [{ side: 'buy', client_id: `b${orderNo++}`, symbol: sym, notional_quote_units: notional.toString(), max_slippage_bps: MAX_SLIP }];
    }
  }

  return [];
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

rl.on('line', (line) => {
  if (line.trim() === '') return;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    hello = msg;
    warmup = msg.warmup_bars ?? 0;
    const q = msg.capital?.quote_units;
    if (typeof q === 'string' && /^[0-9]+$/.test(q)) startEq = BigInt(q);
  } else if (msg.type === 'batch') {
    let orders: any[] = [];
    orders = decide(msg);
    if (orders.length > MAX_ORDERS) orders = orders.slice(0, MAX_ORDERS);
    out({ type: 'reply', seq: msg.seq, orders });
  } else if (msg.type === 'done') {
    rl.close();
    process.exit(0);
  }
});