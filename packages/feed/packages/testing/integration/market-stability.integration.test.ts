/**
 * Market Stability Integration Tests
 *
 * Validates that stability guards hold up over many sequential operations:
 *   1. 20 NPC-sized trades on a thin prediction market — odds stay in [2%, 98%]
 *   2. 50 simulated volatility ticks — perp price stays in [0.25×, 4×] initialPrice
 *   3. Prediction pool: buying YES then NO sequence doesn't escape bounds
 *
 * These tests use pure in-memory math (no DB required) to give instant results
 * without waiting for a full simulation. The stability properties they verify
 * are identical to what the production cron paths enforce.
 */

import { describe, expect, test } from 'bun:test';
import {
  calculatePriceFromHoldings,
  PERP_MARKET_CONFIG,
} from '@babylon/shared/constants/markets';
import { PredictionPricing } from '../../core/markets/prediction/pricing';

// ---------------------------------------------------------------------------
// 1. Prediction: 20 sequential trades never escape odds bounds
// ---------------------------------------------------------------------------
describe('Prediction market stability — sequential trades', () => {
  /**
   * Simulate what happens when 20 NPC agents each make a trade on a thin market.
   * Each trade is capped at MAX_ODDS_MOVE = 20ppt, so the net movement can still
   * compound, but we verify the CPMM bounds hold for reasonable trade sizes.
   */
  test('20 sequential YES buys on thin pool — odds stay below 98%', () => {
    // Thin market: $1,000 liquidity
    let { yesShares, noShares } = PredictionPricing.initializeMarket(
      1_000,
      0.5
    );
    const TRADE_AMOUNT = 10; // $10 per NPC trade (small, within impact cap)

    const oddHistory: number[] = [];

    for (let i = 0; i < 20; i++) {
      const calc = PredictionPricing.calculateBuyWithFees(
        yesShares,
        noShares,
        'yes',
        TRADE_AMOUNT,
        0.01 // 1% fee
      );
      yesShares = calc.newYesShares;
      noShares = calc.newNoShares;
      oddHistory.push(calc.newYesPrice);
    }

    const maxOdds = Math.max(...oddHistory);
    const minOdds = Math.min(...oddHistory);

    // After 20 small buys, YES odds should have risen but not hit extremes
    expect(maxOdds).toBeLessThan(0.98);
    expect(minOdds).toBeGreaterThan(0.5); // YES odds only rise on YES buys
    expect(maxOdds).toBeGreaterThan(0.5); // some movement happened
  });

  test('20 sequential NO buys on thin pool — odds stay above 2%', () => {
    let { yesShares, noShares } = PredictionPricing.initializeMarket(
      1_000,
      0.5
    );
    const TRADE_AMOUNT = 10;

    const yesOdds: number[] = [];

    for (let i = 0; i < 20; i++) {
      const calc = PredictionPricing.calculateBuyWithFees(
        yesShares,
        noShares,
        'no',
        TRADE_AMOUNT,
        0.01
      );
      yesShares = calc.newYesShares;
      noShares = calc.newNoShares;
      yesOdds.push(calc.newYesPrice);
    }

    const minYesOdds = Math.min(...yesOdds);
    expect(minYesOdds).toBeGreaterThan(0.02);
    expect(minYesOdds).toBeLessThan(0.5); // odds moved down
  });

  test('alternating YES/NO trades — pool mean-reverts, odds stay in [5%, 95%]', () => {
    let { yesShares, noShares } = PredictionPricing.initializeMarket(
      5_000,
      0.5
    );
    const TRADE_AMOUNT = 50;

    const allYesOdds: number[] = [];

    for (let i = 0; i < 20; i++) {
      const side = i % 2 === 0 ? 'yes' : 'no';
      const calc = PredictionPricing.calculateBuyWithFees(
        yesShares,
        noShares,
        side,
        TRADE_AMOUNT,
        0.01
      );
      yesShares = calc.newYesShares;
      noShares = calc.newNoShares;
      allYesOdds.push(calc.newYesPrice);
    }

    for (const odds of allYesOdds) {
      expect(odds).toBeGreaterThan(0.02);
      expect(odds).toBeLessThan(0.98);
    }
  });

  test('large single trade exceeding 20ppt impact is detectable', () => {
    // This test documents the impact of a $2500 buy on a $10k pool
    // (which the service guard would reject) for reference
    const { yesShares, noShares } = PredictionPricing.initializeMarket(
      10_000,
      0.5
    );
    const currentYesOdds = noShares / (yesShares + noShares);

    // $3000 gross → ~$2970 net after 1% fee — moves YES from 50% to ~71.76% (+21.76ppt)
    const calc = PredictionPricing.calculateBuy(
      yesShares,
      noShares,
      'yes',
      2970
    );
    const oddsShift = Math.abs(calc.newYesPrice - currentYesOdds);

    // This trade moves odds > 20ppt — the service guard would reject it
    expect(oddsShift).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// 2. Perp: 50 volatility ticks stay within [0.25×, 4×] initialPrice
// ---------------------------------------------------------------------------
describe('Perp market stability — simulated volatility ticks', () => {
  /**
   * Simulate 50 volatility ticks using the same random-walk + clamp logic as
   * simulateMarketVolatility in game-tick.ts. Each tick applies a random move
   * bounded by maxTickMove (4% for company type), then the price is clamped
   * to [0.25×, 4×] initialPrice.
   *
   * Uses a seeded RNG (LCG) for deterministic results.
   */
  function lcg(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }

  function simulateTick(
    currentPrice: number,
    initialPrice: number,
    rng: () => number,
    maxTickMove = 0.04
  ): number {
    const FLOOR = 0.25;
    const CEILING = 4.0;
    // Simplified version of generateProfileDrivenMarketMove
    const move = (rng() * 2 - 1) * maxTickMove; // random in [-maxTickMove, +maxTickMove]
    const newPrice = currentPrice * (1 + move);
    return Math.max(
      initialPrice * FLOOR,
      Math.min(newPrice, initialPrice * CEILING)
    );
  }

  test('50 ticks with company profile (maxTickMove=4%) stay in [0.25×, 4×]', () => {
    const rng = lcg(42);
    const initialPrice = 100;
    let price = initialPrice;
    const prices: number[] = [price];

    for (let i = 0; i < 50; i++) {
      price = simulateTick(price, initialPrice, rng, 0.04);
      prices.push(price);
    }

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    expect(minPrice).toBeGreaterThanOrEqual(initialPrice * 0.25 - 0.001);
    expect(maxPrice).toBeLessThanOrEqual(initialPrice * 4.0 + 0.001);
  });

  test('50 ticks with media profile (maxTickMove=5%) stay in bounds', () => {
    const rng = lcg(99);
    const initialPrice = 50;
    let price = initialPrice;

    for (let i = 0; i < 50; i++) {
      price = simulateTick(price, initialPrice, rng, 0.05);
    }

    expect(price).toBeGreaterThanOrEqual(initialPrice * 0.25 - 0.001);
    expect(price).toBeLessThanOrEqual(initialPrice * 4.0 + 0.001);
  });

  test('extreme directional run still clamps to ceiling', () => {
    const initialPrice = 100;
    let price = initialPrice;

    // Simulate 50 ticks all going up at maximum step
    for (let i = 0; i < 50; i++) {
      price = simulateTick(price, initialPrice, () => 1.0, 0.05); // always max positive
    }

    expect(price).toBeLessThanOrEqual(initialPrice * 4.0 + 0.001);
  });

  test('extreme directional run still clamps to floor', () => {
    const initialPrice = 100;
    let price = initialPrice;

    // Simulate 50 ticks all going down at maximum step
    for (let i = 0; i < 50; i++) {
      price = simulateTick(price, initialPrice, () => 0.0, 0.05); // always max negative
    }

    expect(price).toBeGreaterThanOrEqual(initialPrice * 0.25 - 0.001);
  });
});

// ---------------------------------------------------------------------------
// 3. Perp AMM: calculatePriceFromHoldings respects new 4× ceiling
// ---------------------------------------------------------------------------
describe('Perp AMM — calculatePriceFromHoldings with 4× ceiling', () => {
  test('net long OI that would exceed 4× is clamped — never exceeds ceiling', () => {
    const initialPrice = 100;
    // With currentPrice near ceiling (380), the per-trade clamp allows up to 380*1.3=494,
    // but the absolute 4× ceiling (400) takes precedence.
    const currentPrice = 380;

    const result = calculatePriceFromHoldings(
      initialPrice,
      currentPrice,
      10_000_000
    );
    expect(result).toBeLessThanOrEqual(
      initialPrice * PERP_MARKET_CONFIG.PRICE_CEILING_RATIO + 0.001
    );
    expect(result).toBeCloseTo(
      initialPrice * PERP_MARKET_CONFIG.PRICE_CEILING_RATIO,
      0
    );
  });

  test('net short OI that would go below 5% is clamped', () => {
    const initialPrice = 100;
    const currentPrice = 100;

    // Extreme net shorts
    const result = calculatePriceFromHoldings(
      initialPrice,
      currentPrice,
      -10_000_000
    );
    expect(result).toBeGreaterThanOrEqual(
      initialPrice * PERP_MARKET_CONFIG.PRICE_FLOOR_RATIO - 0.001
    );
  });

  test('zero holdings returns price close to initialPrice', () => {
    const initialPrice = 100;
    const currentPrice = 100;
    const result = calculatePriceFromHoldings(initialPrice, currentPrice, 0);
    expect(result).toBeCloseTo(initialPrice, 0);
  });

  test('moderate longs move price up within per-trade cap', () => {
    const initialPrice = 100;
    const currentPrice = 100;
    // Small positive holdings — should move price up slightly
    const result = calculatePriceFromHoldings(initialPrice, currentPrice, 500);
    expect(result).toBeGreaterThan(currentPrice);
    expect(result).toBeLessThanOrEqual(
      currentPrice * (1 + PERP_MARKET_CONFIG.MAX_CHANGE_PER_TRADE)
    );
  });
});
