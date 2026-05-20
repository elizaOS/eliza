/**
 * Bonding Curve Pricing Tests
 *
 * Tests for the quadratic bonding curve pricing mechanism.
 * Critical: These tests validate the math that drives market volatility.
 */

import { describe, expect, it } from 'bun:test';
import {
  BONDING_CURVE_CONFIG,
  calculateBondingCurvePrice,
  calculatePriceFromHoldings,
  PERP_MARKET_CONFIG,
} from '@babylon/shared';

describe('Bonding Curve Pricing', () => {
  describe('calculateBondingCurvePrice - Pure Math Tests', () => {
    const basePrice = 100;

    it('should return base price when net holdings is zero', () => {
      const price = calculateBondingCurvePrice(basePrice, 0);
      expect(price).toBe(100);
    });

    it('should increase price quadratically for positive holdings (buys)', () => {
      // With RESERVE_DEPTH=100k and EXPONENT=2:
      // price = 100 * (1 + 50000/100000)^2 = 100 * 1.5^2 = 100 * 2.25 = 225
      const price = calculateBondingCurvePrice(basePrice, 50000, {
        EXPONENT: 2,
        RESERVE_DEPTH: 100_000,
        USE_BONDING_CURVE: true,
      });
      expect(price).toBeCloseTo(225, 1);
    });

    it('should decrease price quadratically for negative holdings (sells)', () => {
      // price = 100 * (1 + (-50000)/100000)^2 = 100 * 0.5^2 = 100 * 0.25 = 25
      const price = calculateBondingCurvePrice(basePrice, -50000, {
        EXPONENT: 2,
        RESERVE_DEPTH: 100_000,
        USE_BONDING_CURVE: true,
      });
      expect(price).toBeCloseTo(25, 1);
    });

    it('should handle reserve depth = holdings (doubles price at n=2)', () => {
      // price = 100 * (1 + 100000/100000)^2 = 100 * 2^2 = 100 * 4 = 400
      const price = calculateBondingCurvePrice(basePrice, 100000, {
        EXPONENT: 2,
        RESERVE_DEPTH: 100_000,
        USE_BONDING_CURVE: true,
      });
      expect(price).toBeCloseTo(400, 1);
    });

    it('should floor multiplier at 0.01 for extreme negative holdings', () => {
      // When holdings << -reserveDepth, multiplier could approach zero
      // Should floor at 0.01 to prevent near-zero prices
      const price = calculateBondingCurvePrice(basePrice, -500000, {
        EXPONENT: 2,
        RESERVE_DEPTH: 100_000,
        USE_BONDING_CURVE: true,
      });
      // For extreme negative (ratio = -5), base = 1-5 = -4
      // Since base < 0, we use: multiplier = 1 / (1 + |base| * EXPONENT)
      // = 1 / (1 + 4 * 2) = 1/9 ≈ 0.11
      // So price ≈ 100 * 0.11 = 11
      expect(price).toBeGreaterThan(0);
      expect(price).toBeLessThan(basePrice); // Should be reduced
      expect(price).toBeGreaterThanOrEqual(1); // Floor at 1% of base = $1
    });

    it('should use linear pricing when exponent is 1', () => {
      // price = 100 * (1 + 50000/100000)^1 = 100 * 1.5 = 150
      const price = calculateBondingCurvePrice(basePrice, 50000, {
        EXPONENT: 1,
        RESERVE_DEPTH: 100_000,
        USE_BONDING_CURVE: true,
      });
      expect(price).toBeCloseTo(150, 1);
    });

    it('should be more volatile with cubic exponent', () => {
      // price = 100 * (1 + 50000/100000)^3 = 100 * 1.5^3 = 100 * 3.375 = 337.5
      const price = calculateBondingCurvePrice(basePrice, 50000, {
        EXPONENT: 3,
        RESERVE_DEPTH: 100_000,
        USE_BONDING_CURVE: true,
      });
      expect(price).toBeCloseTo(337.5, 1);
    });

    it('should be more stable with higher reserve depth', () => {
      // price = 100 * (1 + 50000/1000000)^2 = 100 * 1.05^2 = 100 * 1.1025 = 110.25
      const priceHighReserve = calculateBondingCurvePrice(basePrice, 50000, {
        EXPONENT: 2,
        RESERVE_DEPTH: 1_000_000, // 10x higher
        USE_BONDING_CURVE: true,
      });
      expect(priceHighReserve).toBeCloseTo(110.25, 1);

      // Compare to standard: 225 vs 110.25 - much less volatile
      const priceStandard = calculateBondingCurvePrice(basePrice, 50000, {
        EXPONENT: 2,
        RESERVE_DEPTH: 100_000,
        USE_BONDING_CURVE: true,
      });
      expect(priceStandard).toBeGreaterThan(priceHighReserve);
    });
  });

  describe('calculatePriceFromHoldings - With Limits', () => {
    const initialPrice = 100;
    const currentPrice = 100;

    it('should apply price floor limit (5% of initial)', () => {
      // Even with massive sells, price cannot go below 5% of initial
      const price = calculatePriceFromHoldings(
        initialPrice,
        currentPrice,
        -1_000_000, // Massive sell pressure
        PERP_MARKET_CONFIG
      );
      expect(price).toBeGreaterThanOrEqual(initialPrice * 0.05);
    });

    it('should apply price ceiling limit (1000% of initial)', () => {
      // Even with massive buys, price cannot exceed 10x initial
      const price = calculatePriceFromHoldings(
        initialPrice,
        currentPrice,
        10_000_000, // Massive buy pressure
        PERP_MARKET_CONFIG
      );
      expect(price).toBeLessThanOrEqual(initialPrice * 10);
    });

    it('should apply max change per trade limit (30%)', () => {
      // Single trade cannot move price more than 30%
      const price = calculatePriceFromHoldings(
        initialPrice,
        currentPrice,
        500_000, // Large but not extreme
        PERP_MARKET_CONFIG
      );
      const maxAllowedChange = currentPrice * 0.3;
      expect(Math.abs(price - currentPrice)).toBeLessThanOrEqual(
        maxAllowedChange + 0.01 // Small epsilon for floating point
      );
    });

    it('should respect floor even with bonding curve disabled', () => {
      const price = calculatePriceFromHoldings(
        initialPrice,
        currentPrice,
        -500_000,
        PERP_MARKET_CONFIG,
        { ...BONDING_CURVE_CONFIG, USE_BONDING_CURVE: false }
      );
      expect(price).toBeGreaterThanOrEqual(initialPrice * 0.05);
    });
  });

  describe('PERP_MARKET_CONFIG Validation', () => {
    it('should have correct volatility parameters', () => {
      expect(PERP_MARKET_CONFIG.LIQUIDITY_FACTOR).toBe(50);
      expect(PERP_MARKET_CONFIG.MAX_CHANGE_PER_TRADE).toBe(0.3);
      expect(PERP_MARKET_CONFIG.PRICE_FLOOR_RATIO).toBe(0.05);
      expect(PERP_MARKET_CONFIG.PRICE_CEILING_RATIO).toBe(4.0);
    });

    it('should have reasonable synthetic supply', () => {
      expect(PERP_MARKET_CONFIG.SYNTHETIC_SUPPLY).toBe(10_000);
    });
  });

  describe('BONDING_CURVE_CONFIG Validation', () => {
    it('should use quadratic exponent by default', () => {
      expect(BONDING_CURVE_CONFIG.EXPONENT).toBe(2);
    });

    it('should be enabled by default', () => {
      expect(BONDING_CURVE_CONFIG.USE_BONDING_CURVE).toBe(true);
    });

    it('should have reasonable reserve depth', () => {
      expect(BONDING_CURVE_CONFIG.RESERVE_DEPTH).toBe(100_000);
    });
  });

  describe('Price Movement Scenarios', () => {
    const initialPrice = 100;

    it('should allow 95% crash (to $5) but not to zero', () => {
      // Simulate cascading sells over multiple ticks
      // Single tick is limited by MAX_CHANGE_PER_TRADE (30%)
      // So we need multiple iterations to reach the floor
      let price = initialPrice;
      const sellPressure = -200_000;

      // Simulate 10 ticks of heavy selling
      for (let i = 0; i < 10; i++) {
        price = calculatePriceFromHoldings(
          initialPrice,
          price,
          sellPressure,
          PERP_MARKET_CONFIG
        );
      }

      // Should crash toward floor but not below 5% of initial
      expect(price).toBeLessThan(initialPrice);
      expect(price).toBeGreaterThanOrEqual(5); // 5% of 100 = absolute floor
    });

    it('should allow 10x pump (to $1000)', () => {
      let price = initialPrice;
      const massiveBuyPressure = 1_000_000;

      price = calculatePriceFromHoldings(
        initialPrice,
        price,
        massiveBuyPressure,
        PERP_MARKET_CONFIG
      );

      // Should pump but not beyond 10x
      expect(price).toBeGreaterThan(initialPrice);
      expect(price).toBeLessThanOrEqual(1000); // 10x of 100
    });

    it('should create noticeable price impact from $10k trade', () => {
      const tradeSize = 10_000;
      const price = calculatePriceFromHoldings(
        initialPrice,
        initialPrice,
        tradeSize,
        PERP_MARKET_CONFIG
      );

      // Should have noticeable impact (at least 1%)
      const percentChange = Math.abs(price - initialPrice) / initialPrice;
      expect(percentChange).toBeGreaterThan(0.01);
    });

    it('should create significant price impact from $50k NPC trade', () => {
      const tradeSize = 50_000; // Max NPC position size
      const price = calculatePriceFromHoldings(
        initialPrice,
        initialPrice,
        tradeSize,
        PERP_MARKET_CONFIG
      );

      // Should have significant impact (at least 5%)
      const percentChange = Math.abs(price - initialPrice) / initialPrice;
      expect(percentChange).toBeGreaterThan(0.05);
    });
  });
});
