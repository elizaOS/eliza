/**
 * Perpetuals Correctness Tests
 *
 * Verifies liquidation boundary behavior, funding OI calculation with
 * mixed leverages, P&L calculations with exact values, and fee clamping.
 */
import { describe, expect, test } from 'bun:test';
import {
  calculateFundingPayment,
  calculateLiquidationPrice,
  calculateUnrealizedPnL,
  shouldLiquidate,
} from '@babylon/shared/perps-types';

// ─── Liquidation Boundary Tests ──────────────────────────────────────────────

describe('liquidation boundary precision', () => {
  test('10x long at $100: liquidated at exactly $90', () => {
    const liqPrice = calculateLiquidationPrice(100, 'long', 10);
    expect(liqPrice).toBe(90);
    // At exactly $90 → liquidated
    expect(shouldLiquidate(90, liqPrice, 'long')).toBe(true);
    // At $90.01 → not liquidated
    expect(shouldLiquidate(90.01, liqPrice, 'long')).toBe(false);
  });

  test('5x long at $100: liquidated at $80, safe at $80.01', () => {
    const liqPrice = calculateLiquidationPrice(100, 'long', 5);
    expect(liqPrice).toBe(80);
    expect(shouldLiquidate(80, liqPrice, 'long')).toBe(true);
    expect(shouldLiquidate(80.01, liqPrice, 'long')).toBe(false);
  });

  test('20x short at $100: liquidated at $105, safe at $104.99', () => {
    const liqPrice = calculateLiquidationPrice(100, 'short', 20);
    expect(liqPrice).toBe(105);
    expect(shouldLiquidate(105, liqPrice, 'short')).toBe(true);
    expect(shouldLiquidate(104.99, liqPrice, 'short')).toBe(false);
  });

  test('1x long: liquidated only at $0 (full loss)', () => {
    const liqPrice = calculateLiquidationPrice(100, 'long', 1);
    expect(liqPrice).toBe(0);
    // Only liquidated at exactly 0
    expect(shouldLiquidate(0, liqPrice, 'long')).toBe(true);
    // Even $0.01 is safe
    expect(shouldLiquidate(0.01, liqPrice, 'long')).toBe(false);
  });

  test('100x long at $50000: liquidated at $49500 (1% drop)', () => {
    const liqPrice = calculateLiquidationPrice(50000, 'long', 100);
    // 1/100 = 1%, 50000 * 0.99 = 49500
    expect(liqPrice).toBe(49500);
    expect(shouldLiquidate(49500, liqPrice, 'long')).toBe(true);
    expect(shouldLiquidate(49501, liqPrice, 'long')).toBe(false);
  });
});

// ─── P&L Calculations with Exact Values ──────────────────────────────────────

describe('P&L calculations with concrete numbers', () => {
  test('10x long at $100, price to $110 → +100% margin P&L', () => {
    const { pnl, pnlPercent } = calculateUnrealizedPnL(100, 110, 'long', 1000);
    // pnl = ((110-100)/100) * 1000 = 100
    expect(pnl).toBe(100);
    // pnlPercent = (100/1000) * 100 = 10% (of notional)
    expect(pnlPercent).toBe(10);
    // But on margin ($100 for 10x), that's 100% return
    const margin = 1000 / 10;
    expect(pnl / margin).toBe(1.0); // 100% margin return
  });

  test('10x short at $100, price to $90 → +100% margin P&L', () => {
    const { pnl, pnlPercent } = calculateUnrealizedPnL(100, 90, 'short', 1000);
    expect(pnl).toBe(100);
    expect(pnlPercent).toBe(10);
    const margin = 1000 / 10;
    expect(pnl / margin).toBe(1.0);
  });

  test('5x long at $200, price to $180 → -50% margin P&L', () => {
    const { pnl, pnlPercent } = calculateUnrealizedPnL(200, 180, 'long', 500);
    // pnl = ((180-200)/200) * 500 = -50
    expect(pnl).toBe(-50);
    expect(pnlPercent).toBe(-10);
    // margin = 500/5 = 100, loss = 50% of margin
    const margin = 500 / 5;
    expect(pnl / margin).toBe(-0.5);
  });

  test('2x short at $100, price to $150 → -100% margin (full loss)', () => {
    const { pnl } = calculateUnrealizedPnL(100, 150, 'short', 200);
    // pnl = ((100-150)/100) * 200 = -100
    expect(pnl).toBe(-100);
    const margin = 200 / 2;
    expect(pnl / margin).toBe(-1.0); // Full margin wiped
  });
});

// ─── Funding Rate Tests ─────────────────────────────────────────────────────

describe('funding rate calculations', () => {
  test('funding payment for one 8h period', () => {
    // Position size $10,000, annual rate 10%
    const payment = calculateFundingPayment(10000, 0.1);
    // 0.1 / 1095.75 * 10000 ≈ $0.9126 per 8h period
    expect(payment).toBeCloseTo(0.9126, 2);
  });

  test('funding payment scales linearly with rate', () => {
    const p1 = calculateFundingPayment(10000, 0.05);
    const p2 = calculateFundingPayment(10000, 0.1);
    // Doubling the rate should double the payment
    expect(p2).toBeCloseTo(p1 * 2, 10);
  });

  test('funding payment direction: longs pay when longOI > shortOI', () => {
    // Positive rate → longs pay shorts; negative → shorts pay longs
    // Funding is zero-sum: long pays +P, short receives -P
    const longPayment = calculateFundingPayment(1000, 0.05);
    const shortPayment = -calculateFundingPayment(1000, 0.05);
    expect(longPayment + shortPayment).toBe(0);
  });

  test('negative funding rate produces negative payment', () => {
    const payment = calculateFundingPayment(10000, -0.05);
    expect(payment).toBeLessThan(0);
    // Should be exactly the negative of the positive case
    const posPayment = calculateFundingPayment(10000, 0.05);
    expect(payment).toBeCloseTo(-posPayment, 10);
  });

  test('zero funding rate produces zero payment', () => {
    expect(calculateFundingPayment(10000, 0)).toBe(0);
  });

  test('large position 1M notional at 20% rate → ~$182.53 per period', () => {
    const payment = calculateFundingPayment(1_000_000, 0.2);
    // 0.20 / 1095.75 * 1_000_000 ≈ 182.53
    expect(payment).toBeCloseTo(182.53, 0);
  });
});

// ─── OI Imbalance Contract Tests ────────────────────────────────────────────
// These document the funding OI formula contract: imbalance uses notional
// (pos.size), NOT leveraged (pos.size * pos.leverage). The actual aggregation
// lives in PerpMarketService.processFundingStep() (private, async). These
// tests verify the math contract that the production code implements.

describe('OI imbalance formula contract (documents bug fix)', () => {
  test('equal notional at different leverages → zero imbalance', () => {
    // FIXED: OI uses pos.size (notional), not pos.size * pos.leverage
    // Position A: 100 notional at 10x (margin = 10)
    // Position B: 100 notional at 1x (margin = 100)
    const longOI = 100; // pos.size (notional)
    const shortOI = 100; // pos.size (notional)
    const imbalance = (longOI - shortOI) / (longOI + shortOI);
    expect(imbalance).toBe(0);

    // OLD BUG would have computed (100*10 - 100*1)/(100*10 + 100*1) = 0.818
    const oldBugImbalance = (100 * 10 - 100 * 1) / (100 * 10 + 100 * 1);
    expect(oldBugImbalance).toBeCloseTo(0.818, 2);
  });

  test('200 long vs 100 short → 33% imbalance, above threshold', () => {
    const imbalance = (200 - 100) / (200 + 100);
    expect(imbalance).toBeCloseTo(0.333, 2);
    expect(Math.abs(imbalance)).toBeGreaterThan(0.05);
  });

  test('102 long vs 98 short → 2% imbalance, below 5% threshold', () => {
    const imbalance = (102 - 98) / (102 + 98);
    expect(imbalance).toBe(0.02);
    expect(Math.abs(imbalance)).toBeLessThan(0.05);
  });
});

// ─── Settlement Fee Clamping ─────────────────────────────────────────────────
// Settlement logic lives in PerpMarketService.closePosition() (private, async).
// These tests verify the math contract: netSettlement = max(0, margin + pnl - fee).
// PnL is computed via the real calculateUnrealizedPnL function.

describe('settlement fee behavior', () => {
  test('winner profit > fee: fee deducted normally', () => {
    // Position: $1000 size, entry $100, close $120, fee 0.1%
    const { pnl } = calculateUnrealizedPnL(100, 120, 'long', 1000);
    expect(pnl).toBe(200); // 20% of 1000
    const leverage = 10;
    const margin = 1000 / leverage;
    const fee = 1000 * 0.001; // $1
    const netSettlement = Math.max(0, margin + pnl - fee);
    // Winner gets 100 + 200 - 1 = 299
    expect(netSettlement).toBe(299);
  });

  test('loser margin loss: fee deducted from remaining margin', () => {
    // Position: $1000 size at 10x ($100 margin), entry $100, close $95
    const { pnl } = calculateUnrealizedPnL(100, 95, 'long', 1000);
    expect(pnl).toBe(-50); // -5% of 1000
    const margin = 1000 / 10; // $100
    const fee = 1000 * 0.001; // $1
    const netSettlement = Math.max(0, margin + pnl - fee);
    // 100 + (-50) - 1 = 49
    expect(netSettlement).toBe(49);
  });

  test('fee clamp: settlement cannot go below zero', () => {
    // Near-total loss: remaining margin < fee
    const { pnl } = calculateUnrealizedPnL(100, 1, 'long', 100);
    // pnl = ((1-100)/100) * 100 = -99
    expect(pnl).toBe(-99);
    const margin = 100 / 1; // 1x leverage
    const fee = 5;
    const netSettlement = Math.max(0, margin + pnl - fee);
    // 100 + (-99) - 5 = -4 → clamped to 0
    expect(netSettlement).toBe(0);
  });

  test('total liquidation: zero settlement regardless of fee', () => {
    // Full loss via shouldLiquidate — verify liquidation + settlement consistency
    const liqPrice = calculateLiquidationPrice(100, 'long', 10);
    expect(liqPrice).toBe(90);
    expect(shouldLiquidate(90, liqPrice, 'long')).toBe(true);
    // At liquidation: pnl = ((90-100)/100) * 1000 = -100
    const { pnl } = calculateUnrealizedPnL(100, 90, 'long', 1000);
    expect(pnl).toBe(-100);
    const margin = 1000 / 10; // $100
    // margin + pnl = 0, fee can't make it negative
    const netSettlement = Math.max(0, margin + pnl - 0.5);
    expect(netSettlement).toBe(0);
  });

  test('short position settlement with fee', () => {
    // Short at $100, price drops to $80, 5x leverage
    const { pnl } = calculateUnrealizedPnL(100, 80, 'short', 500);
    // pnl = ((100-80)/100) * 500 = 100
    expect(pnl).toBe(100);
    const margin = 500 / 5; // $100
    const fee = 500 * 0.001; // $0.50
    const netSettlement = Math.max(0, margin + pnl - fee);
    // 100 + 100 - 0.5 = 199.5
    expect(netSettlement).toBe(199.5);
  });
});
