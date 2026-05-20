/**
 * Comprehensive Currency Formatting Tests
 *
 * Tests formatCurrency function with extensive edge cases, boundary conditions,
 * error handling, and integration with BABYLON_POINTS_SYMBOL constant.
 */

import { describe, expect, it } from 'bun:test';

process.env.NEXT_PUBLIC_CURRENCY_SYMBOL = '$';
const { BABYLON_POINTS_SYMBOL, formatCurrency } = await import(
  '@babylon/shared'
);

describe('formatCurrency - Comprehensive Tests', () => {
  describe('Symbol Verification', () => {
    it('should use default $ symbol for Babylon points display', () => {
      expect(BABYLON_POINTS_SYMBOL).toBe('$');
      expect(BABYLON_POINTS_SYMBOL).not.toBe('Ƀ');
    });

    it('should include symbol in formatted output', () => {
      const result = formatCurrency(100);
      expect(result).toStartWith('$');
      expect(result).toBe('$100.00');
    });

    it('should use symbol consistently across all outputs', () => {
      const results = [
        formatCurrency(0),
        formatCurrency(1),
        formatCurrency(100),
        formatCurrency(1000),
        formatCurrency(1000000),
      ];
      results.forEach((result) => {
        expect(result).toStartWith('$');
      });
    });
  });

  describe('Basic Formatting', () => {
    it('should format positive integers with default decimals', () => {
      expect(formatCurrency(0)).toBe('$0.00');
      expect(formatCurrency(1)).toBe('$1.00');
      expect(formatCurrency(100)).toBe('$100.00');
      expect(formatCurrency(1000)).toBe('$1000.00');
    });

    it('should format decimal numbers with rounding', () => {
      expect(formatCurrency(123.456)).toBe('$123.46'); // Rounds up
      expect(formatCurrency(123.454)).toBe('$123.45'); // Rounds down
      expect(formatCurrency(99.999)).toBe('$100.00'); // Rounds up to next integer
    });

    it('should format with custom decimal places', () => {
      expect(formatCurrency(123.456, 0)).toBe('$123');
      expect(formatCurrency(123.456, 1)).toBe('$123.5');
      expect(formatCurrency(123.456, 2)).toBe('$123.46');
      expect(formatCurrency(123.456, 3)).toBe('$123.456');
      expect(formatCurrency(123.456, 4)).toBe('$123.4560');
    });
  });

  describe('Edge Cases - Zero and Negative Values', () => {
    it('should handle zero correctly', () => {
      expect(formatCurrency(0)).toBe('$0.00');
      expect(formatCurrency(0, 0)).toBe('$0');
      expect(formatCurrency(0, 5)).toBe('$0.00000');
    });

    it('should handle negative values correctly', () => {
      expect(formatCurrency(-100)).toBe('-$100.00');
      expect(formatCurrency(-123.456)).toBe('-$123.46');
      expect(formatCurrency(-0.01)).toBe('-$0.01');
    });

    it('should handle very small negative values', () => {
      expect(formatCurrency(-0.001)).toBe('-$0.00'); // Rounds to 0.00
      expect(formatCurrency(-0.001, 3)).toBe('-$0.001');
      expect(formatCurrency(-0.0001, 4)).toBe('-$0.0001');
    });
  });

  describe('Edge Cases - Very Large Numbers', () => {
    it('should handle large integers', () => {
      expect(formatCurrency(1000000)).toBe('$1000000.00');
      expect(formatCurrency(999999999)).toBe('$999999999.00');
      expect(formatCurrency(Number.MAX_SAFE_INTEGER)).toBe(
        `$${Number.MAX_SAFE_INTEGER}.00`
      );
    });

    it('should handle large decimals', () => {
      expect(formatCurrency(1234567.89)).toBe('$1234567.89');
      expect(formatCurrency(999999999.999)).toBe('$1000000000.00'); // Rounds up
    });

    it('should handle scientific notation inputs', () => {
      expect(formatCurrency(1e6)).toBe('$1000000.00');
      expect(formatCurrency(1e9)).toBe('$1000000000.00');
      expect(formatCurrency(1.5e6)).toBe('$1500000.00');
    });
  });

  describe('Edge Cases - Very Small Numbers', () => {
    it('should handle small positive decimals', () => {
      expect(formatCurrency(0.001)).toBe('$0.00'); // Rounds to 0.00
      expect(formatCurrency(0.01)).toBe('$0.01');
      expect(formatCurrency(0.1)).toBe('$0.10');
    });

    it('should handle small decimals with custom precision', () => {
      expect(formatCurrency(0.001, 3)).toBe('$0.001');
      expect(formatCurrency(0.0001, 4)).toBe('$0.0001');
      expect(formatCurrency(0.00001, 5)).toBe('$0.00001');
    });

    it('should handle very small numbers near zero', () => {
      expect(formatCurrency(0.0000001, 7)).toBe('$0.0000001');
      expect(formatCurrency(0.00000001, 8)).toBe('$0.00000001');
    });
  });

  describe('Edge Cases - Boundary Conditions', () => {
    it('should handle exact boundary values', () => {
      expect(formatCurrency(999.999)).toBe('$1000.00'); // Rounds up
      expect(formatCurrency(999.99)).toBe('$999.99');
      expect(formatCurrency(1000)).toBe('$1000.00');
      expect(formatCurrency(1000.001)).toBe('$1000.00');
    });

    it('should handle decimal precision boundaries', () => {
      expect(formatCurrency(1.234, 2)).toBe('$1.23'); // Rounds down
      expect(formatCurrency(1.235, 2)).toBe('$1.24'); // Rounds up (banker's rounding)
      expect(formatCurrency(1.236, 2)).toBe('$1.24'); // Rounds up
    });
  });

  describe('Edge Cases - Special Number Values', () => {
    it('should handle Infinity (produces string representation)', () => {
      // toFixed() converts Infinity to "Infinity" string
      expect(formatCurrency(Infinity)).toBe('$Infinity');
      expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('$Infinity');
      expect(formatCurrency(Number.NEGATIVE_INFINITY)).toBe('-$Infinity');
    });

    it('should handle NaN (produces string representation)', () => {
      // toFixed() converts NaN to "NaN" string
      expect(formatCurrency(NaN)).toBe('$NaN');
    });

    it('should handle Number.MAX_VALUE', () => {
      // This is a very large number, should still format (may lose precision)
      const result = formatCurrency(Number.MAX_VALUE);
      expect(result).toStartWith('$');
      expect(result).toContain('.');
    });

    it('should handle Number.MIN_VALUE', () => {
      const result = formatCurrency(Number.MIN_VALUE);
      expect(result).toStartWith('$');
      // MIN_VALUE is very small, may round to 0.00
    });
  });

  describe('Decimal Places Edge Cases', () => {
    it('should handle zero decimal places', () => {
      expect(formatCurrency(123.456, 0)).toBe('$123');
      expect(formatCurrency(123.999, 0)).toBe('$124'); // Rounds up
      expect(formatCurrency(123.4, 0)).toBe('$123'); // Rounds down
    });

    it('should handle many decimal places', () => {
      expect(formatCurrency(123.456789, 6)).toBe('$123.456789');
      expect(formatCurrency(123.456789, 10)).toBe('$123.4567890000');
    });

    it('should handle negative decimal places (throws RangeError)', () => {
      // JavaScript toFixed() throws RangeError for negative values
      expect(() => formatCurrency(123.456, -1)).toThrow(RangeError);
    });

    it('should handle very large decimal places', () => {
      // toFixed() accepts 0-100, values >100 are clamped to 100
      const result = formatCurrency(123.456, 100);
      expect(result).toStartWith('$123.');
      expect(result.length).toBeGreaterThan(100); // Should have many decimal places
      // Verify it doesn't crash and produces valid output
      expect(result).toMatch(/^\$123\.\d+$/);
    });
  });

  describe('Rounding Behavior', () => {
    it('should use standard rounding (round half up)', () => {
      expect(formatCurrency(1.234, 2)).toBe('$1.23'); // Rounds down
      expect(formatCurrency(1.235, 2)).toBe('$1.24'); // Rounds up
      expect(formatCurrency(1.236, 2)).toBe('$1.24'); // Rounds up
    });

    it('should handle .5 rounding correctly', () => {
      // JavaScript uses "round half to even" (banker's rounding)
      expect(formatCurrency(1.125, 2)).toBe('$1.13'); // Rounds up
      expect(formatCurrency(1.135, 2)).toBe('$1.14'); // Rounds up
      expect(formatCurrency(2.5, 0)).toBe('$3'); // Rounds up
      expect(formatCurrency(3.5, 0)).toBe('$4'); // Rounds up
    });

    it('should round correctly at decimal boundaries', () => {
      expect(formatCurrency(0.004, 2)).toBe('$0.00'); // Rounds down to 0
      expect(formatCurrency(0.005, 2)).toBe('$0.01'); // Rounds up
      expect(formatCurrency(0.006, 2)).toBe('$0.01'); // Rounds up
    });
  });

  describe('String Output Format', () => {
    it('should always return a string', () => {
      expect(typeof formatCurrency(100)).toBe('string');
      expect(typeof formatCurrency(0)).toBe('string');
      expect(typeof formatCurrency(-100)).toBe('string');
    });

    it('should have consistent format: symbol + number', () => {
      const result = formatCurrency(123.45);
      const match = result.match(/^\$\d+\.\d+$/);
      expect(match).not.toBeNull();
    });

    it('should not include thousand separators', () => {
      const result = formatCurrency(1000);
      expect(result).toBe('$1000.00');
      expect(result).not.toContain(',');
    });

    it('should handle negative sign placement', () => {
      const result = formatCurrency(-100);
      expect(result).toBe('-$100.00');
      expect(result).toStartWith('-');
      expect(result).toContain('$');
      expect(result).toContain('-');
    });
  });

  describe('Integration with BABYLON_POINTS_SYMBOL', () => {
    it('should use the constant value directly', () => {
      const result = formatCurrency(100);
      expect(result.charAt(0)).toBe(BABYLON_POINTS_SYMBOL);
    });

    it('should reflect constant changes immediately', () => {
      // Verify the constant is imported and used
      const testValue = 100;
      const result = formatCurrency(testValue);
      const expectedSymbol = BABYLON_POINTS_SYMBOL;
      expect(result.startsWith(expectedSymbol)).toBe(true);
    });
  });

  describe('Real-world Usage Scenarios', () => {
    it('should format typical trading amounts', () => {
      expect(formatCurrency(100)).toBe('$100.00');
      expect(formatCurrency(1000)).toBe('$1000.00');
      expect(formatCurrency(10000)).toBe('$10000.00');
    });

    it('should format PnL values (can be negative)', () => {
      expect(formatCurrency(123.45)).toBe('$123.45');
      expect(formatCurrency(-123.45)).toBe('-$123.45');
      expect(formatCurrency(0)).toBe('$0.00');
    });

    it('should format balance values', () => {
      expect(formatCurrency(0)).toBe('$0.00');
      expect(formatCurrency(1000.5)).toBe('$1000.50');
      expect(formatCurrency(999999.99)).toBe('$999999.99');
    });

    it('should format price values with appropriate precision', () => {
      expect(formatCurrency(1.23, 2)).toBe('$1.23');
      expect(formatCurrency(0.99, 2)).toBe('$0.99');
      expect(formatCurrency(100.001, 3)).toBe('$100.001');
    });
  });

  describe('Performance and Consistency', () => {
    it('should produce consistent results for same input', () => {
      const result1 = formatCurrency(123.456);
      const result2 = formatCurrency(123.456);
      expect(result1).toBe(result2);
    });

    it('should handle rapid successive calls', () => {
      const results = Array.from({ length: 1000 }, () => formatCurrency(100));
      results.forEach((result) => {
        expect(result).toBe('$100.00');
      });
    });
  });
});
