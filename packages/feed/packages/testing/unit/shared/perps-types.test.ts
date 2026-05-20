/**
 * Tests for Perpetuals trading calculation utilities
 */
import { describe, expect, it } from 'bun:test';
import {
  calculateFundingPayment,
  calculateLiquidationPrice,
  calculateMarkPrice,
  calculateUnrealizedPnL,
  shouldLiquidate,
} from '@babylon/shared/perps-types';

describe('Perpetuals Calculation Utilities', () => {
  describe('calculateLiquidationPrice', () => {
    it('should calculate liquidation price for long position', () => {
      // Entry: $100, Leverage: 10x
      // Liquidation threshold = 1 / 10 = 0.1
      // Liquidation price = 100 * (1 - 0.1) = 90
      const result = calculateLiquidationPrice(100, 'long', 10);
      expect(result).toBe(90);
    });

    it('should calculate liquidation price for short position', () => {
      // Entry: $100, Leverage: 10x
      // Liquidation threshold = 1 / 10 = 0.1
      // Liquidation price = 100 * (1 + 0.1) = 110
      const result = calculateLiquidationPrice(100, 'short', 10);
      expect(result).toBeCloseTo(110, 10);
    });

    it('should handle different leverage levels', () => {
      // Higher leverage = tighter liquidation
      const liq5x = calculateLiquidationPrice(100, 'long', 5);
      const liq20x = calculateLiquidationPrice(100, 'long', 20);

      // 5x: 100 * (1 - 1/5) = 100 * 0.8 = 80
      expect(liq5x).toBe(80);

      // 20x: 100 * (1 - 1/20) = 100 * 0.95 = 95
      expect(liq20x).toBe(95);

      // Higher leverage = closer to entry
      expect(liq20x).toBeGreaterThan(liq5x);
    });

    it('should handle 1x leverage (full margin loss = price goes to zero)', () => {
      // 1x: 100 * (1 - 1/1) = 100 * 0 = 0
      const result = calculateLiquidationPrice(100, 'long', 1);
      expect(result).toBeCloseTo(0, 10);
    });
  });

  describe('calculateUnrealizedPnL', () => {
    it('should calculate profit for long position when price goes up', () => {
      // Entry: $100, Current: $110, Size: $1000
      // PnL = ((110 - 100) / 100) * 1000 = 100
      const result = calculateUnrealizedPnL(100, 110, 'long', 1000);
      expect(result.pnl).toBe(100);
      expect(result.pnlPercent).toBe(10); // 10% profit
    });

    it('should calculate loss for long position when price goes down', () => {
      // Entry: $100, Current: $90, Size: $1000
      // PnL = ((90 - 100) / 100) * 1000 = -100
      const result = calculateUnrealizedPnL(100, 90, 'long', 1000);
      expect(result.pnl).toBe(-100);
      expect(result.pnlPercent).toBe(-10); // 10% loss
    });

    it('should calculate profit for short position when price goes down', () => {
      // Entry: $100, Current: $90, Size: $1000
      // PnL = ((100 - 90) / 100) * 1000 = 100
      const result = calculateUnrealizedPnL(100, 90, 'short', 1000);
      expect(result.pnl).toBe(100);
      expect(result.pnlPercent).toBe(10); // 10% profit
    });

    it('should calculate loss for short position when price goes up', () => {
      // Entry: $100, Current: $110, Size: $1000
      // PnL = ((100 - 110) / 100) * 1000 = -100
      const result = calculateUnrealizedPnL(100, 110, 'short', 1000);
      expect(result.pnl).toBe(-100);
      expect(result.pnlPercent).toBe(-10); // 10% loss
    });

    it('should return zero when price unchanged', () => {
      const resultLong = calculateUnrealizedPnL(100, 100, 'long', 1000);
      const resultShort = calculateUnrealizedPnL(100, 100, 'short', 1000);

      expect(resultLong.pnl).toBe(0);
      expect(resultLong.pnlPercent).toBe(0);
      expect(resultShort.pnl).toBe(0);
      expect(resultShort.pnlPercent).toBe(0);
    });
  });

  describe('calculateFundingPayment', () => {
    it('should calculate funding payment for single 8-hour period', () => {
      // Position: $10000, Rate: 1% annual
      // 8-hour period: 0.01 / 1095.75 ≈ 0.0000091261
      // Payment: 10000 * 0.0000091261 ≈ 0.0913
      const result = calculateFundingPayment(10000, 0.01);
      expect(result).toBeCloseTo(0.0913, 3);
    });

    it('should return zero for zero funding rate', () => {
      const result = calculateFundingPayment(10000, 0);
      expect(result).toBe(0);
    });

    it('should scale linearly with position size', () => {
      const small = calculateFundingPayment(1000, 0.05);
      const large = calculateFundingPayment(10000, 0.05);
      expect(large).toBeCloseTo(small * 10, 10);
    });

    it('should handle negative funding rate', () => {
      const result = calculateFundingPayment(10000, -0.01);
      expect(result).toBeLessThan(0);
    });
  });

  describe('shouldLiquidate', () => {
    it('should return true when long position hits liquidation price', () => {
      expect(shouldLiquidate(90, 91, 'long')).toBe(true);
      expect(shouldLiquidate(91, 91, 'long')).toBe(true);
    });

    it('should return false when long position above liquidation price', () => {
      expect(shouldLiquidate(92, 91, 'long')).toBe(false);
    });

    it('should return true when short position hits liquidation price', () => {
      expect(shouldLiquidate(110, 109, 'short')).toBe(true);
      expect(shouldLiquidate(109, 109, 'short')).toBe(true);
    });

    it('should return false when short position below liquidation price', () => {
      expect(shouldLiquidate(108, 109, 'short')).toBe(false);
    });
  });

  describe('calculateMarkPrice', () => {
    it('should weight index and last price correctly', () => {
      // 70% index + 30% last
      // Index: 100, Last: 100, Rate: 0
      // Mark = 100 * 0.7 + 100 * 0.3 = 100
      const result = calculateMarkPrice(100, 100, 0);
      expect(result).toBe(100);
    });

    it('should apply funding rate adjustment', () => {
      // Index: 100, Last: 100, Rate: 0.01 (1% annual)
      // Base = 100
      // Adjustment = 0.01 * 0.01 = 0.0001
      // Mark = 100 * (1 + 0.0001) = 100.01
      const result = calculateMarkPrice(100, 100, 0.01);
      expect(result).toBeCloseTo(100.01, 2);
    });

    it('should weight toward index price', () => {
      // Index: 100, Last: 110
      // Base = 100 * 0.7 + 110 * 0.3 = 70 + 33 = 103
      const result = calculateMarkPrice(100, 110, 0);
      expect(result).toBe(103);
    });

    it('should handle negative funding rate', () => {
      // Negative funding = slight downward adjustment
      const positive = calculateMarkPrice(100, 100, 0.01);
      const negative = calculateMarkPrice(100, 100, -0.01);
      expect(negative).toBeLessThan(positive);
    });
  });
});
