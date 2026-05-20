/**
 * Format Utilities Unit Tests
 * Tests for formatting dates, numbers, and other values
 */

import { describe, expect, it } from 'bun:test';

process.env.NEXT_PUBLIC_CURRENCY_SYMBOL = '$';
const {
  clamp,
  formatCompactCurrency,
  formatCompactNumber,
  formatCurrency,
  formatDate,
  formatNumberWithSeparators,
  formatPercentage,
  formatRelativeTime,
  formatTime,
  sanitizeId,
} = await import('@feed/shared');

describe('Format Utilities', () => {
  describe('clamp', () => {
    it('should clamp values below minimum', () => {
      expect(clamp(-10, 0, 100)).toBe(0);
      expect(clamp(-100, -50, 50)).toBe(-50);
    });

    it('should clamp values above maximum', () => {
      expect(clamp(150, 0, 100)).toBe(100);
      expect(clamp(200, -50, 50)).toBe(50);
    });

    it('should not change values within range', () => {
      expect(clamp(50, 0, 100)).toBe(50);
      expect(clamp(0, -10, 10)).toBe(0);
    });

    it('should handle edge cases', () => {
      expect(clamp(0, 0, 0)).toBe(0);
      expect(clamp(5, 5, 5)).toBe(5);
    });
  });

  describe('formatDate', () => {
    it('should format Date objects', () => {
      const date = new Date('2025-01-15');
      const formatted = formatDate(date);
      expect(formatted).toMatch(/Jan.*15.*2025/);
    });

    it('should format ISO strings', () => {
      const formatted = formatDate('2025-12-25T00:00:00Z');
      expect(formatted).toMatch(/Dec.*25.*2025/);
    });
  });

  describe('formatTime', () => {
    it('should format time from Date objects', () => {
      const date = new Date('2025-01-15T14:30:00');
      const formatted = formatTime(date);
      expect(formatted).toMatch(/2:30\s*PM/i);
    });

    it('should format time from ISO strings', () => {
      const formatted = formatTime('2025-01-15T09:15:00');
      expect(formatted).toMatch(/9:15\s*AM/i);
    });
  });

  describe('formatRelativeTime', () => {
    it('should format recent times in seconds', () => {
      const recentDate = new Date(Date.now() - 30000); // 30 seconds ago
      const formatted = formatRelativeTime(recentDate);
      expect(formatted).toMatch(/\d+s/);
    });

    it('should format times in minutes', () => {
      const minutesAgo = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
      const formatted = formatRelativeTime(minutesAgo);
      expect(formatted).toMatch(/\d+m/);
    });

    it('should format times in hours', () => {
      const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
      const formatted = formatRelativeTime(hoursAgo);
      expect(formatted).toMatch(/\d+h/);
    });

    it('should format times in days', () => {
      const daysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
      const formatted = formatRelativeTime(daysAgo);
      expect(formatted).toMatch(/\d+d/);
    });

    it('should fall back to date format for old dates', () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      const formatted = formatRelativeTime(oldDate);
      expect(formatted).toMatch(/[A-Z][a-z]+.*\d+.*\d{4}/);
    });
  });

  describe('formatCompactNumber', () => {
    it('should format numbers less than 1000 as-is', () => {
      expect(formatCompactNumber(500)).toBe('500');
      expect(formatCompactNumber(0)).toBe('0');
      expect(formatCompactNumber(999)).toBe('999');
      expect(formatCompactNumber(1.6)).toBe('1.6');
      expect(formatCompactNumber(-12.25)).toBe('-12.25');
    });

    it('should format thousands with K suffix', () => {
      expect(formatCompactNumber(1000)).toBe('1.0K');
      expect(formatCompactNumber(1500)).toBe('1.5K');
      expect(formatCompactNumber(999999)).toBe('1000.0K');
    });

    it('should format millions with M suffix', () => {
      expect(formatCompactNumber(1000000)).toBe('1.0M');
      expect(formatCompactNumber(2500000)).toBe('2.5M');
    });

    it('should format billions, trillions, and quadrillions', () => {
      expect(formatCompactNumber(1000000000)).toBe('1.0B');
      expect(formatCompactNumber(1000000000000)).toBe('1.0T');
      expect(formatCompactNumber(1000000000000000)).toBe('1.0Q');
    });

    it('should return 0 for non-finite values', () => {
      expect(formatCompactNumber(Number.NaN)).toBe('0');
      expect(formatCompactNumber(Number.POSITIVE_INFINITY)).toBe('0');
      expect(formatCompactNumber(Number.NEGATIVE_INFINITY)).toBe('0');
    });
  });

  describe('formatCurrency', () => {
    it('should format with default 2 decimal places', () => {
      // Note: formats currency with locale-specific symbol and default two decimal places for clarity.
      expect(formatCurrency(123.456)).toBe('$123.46');
      expect(formatCurrency(100)).toBe('$100.00');
    });

    it('should format with custom decimal places (number param)', () => {
      expect(formatCurrency(123.456, 0)).toBe('$123');
      expect(formatCurrency(123.456, 3)).toBe('$123.456');
    });

    it('should format with options object', () => {
      expect(formatCurrency(123.456, { decimals: 1 })).toBe('$123.5');
      expect(formatCurrency(100, { decimals: 0 })).toBe('$100');
    });

    it('should format with thousands separators when enabled', () => {
      expect(formatCurrency(1234.56, { useThousandsSeparator: true })).toBe(
        '$1,234.56'
      );
      expect(
        formatCurrency(1234567.89, { decimals: 2, useThousandsSeparator: true })
      ).toBe('$1,234,567.89');
      expect(
        formatCurrency(1000000, { decimals: 0, useThousandsSeparator: true })
      ).toBe('$1,000,000');
    });

    it('should not use thousands separators by default', () => {
      expect(formatCurrency(1234.56)).toBe('$1234.56');
      expect(formatCurrency(1234567.89)).toBe('$1234567.89');
    });

    it('should handle negative numbers correctly', () => {
      // Sign before symbol for readability (-$100.00)
      expect(formatCurrency(-100)).toBe('-$100.00');
      expect(formatCurrency(-1234.56)).toBe('-$1234.56');
    });

    it('should handle edge cases with thousands separators', () => {
      expect(formatCurrency(0, { useThousandsSeparator: true })).toBe('$0.00');
      expect(formatCurrency(999, { useThousandsSeparator: true })).toBe(
        '$999.00'
      );
      expect(formatCurrency(-1234.56, { useThousandsSeparator: true })).toBe(
        '-$1,234.56'
      );
    });
  });

  describe('formatCompactCurrency', () => {
    it('should format small values without suffix', () => {
      expect(formatCompactCurrency(500)).toBe('$500.00');
      expect(formatCompactCurrency(0)).toBe('$0.00');
      expect(formatCompactCurrency(999.99)).toBe('$999.99');
    });

    it('should format thousands with K suffix', () => {
      expect(formatCompactCurrency(1000)).toBe('$1.00K');
      expect(formatCompactCurrency(1500)).toBe('$1.50K');
      expect(formatCompactCurrency(999999)).toBe('$1000.00K');
    });

    it('should format millions with M suffix', () => {
      expect(formatCompactCurrency(1000000)).toBe('$1.00M');
      expect(formatCompactCurrency(2300000)).toBe('$2.30M');
      expect(formatCompactCurrency(999999999)).toBe('$1000.00M');
    });

    it('should format billions with B suffix', () => {
      expect(formatCompactCurrency(1000000000)).toBe('$1.00B');
      expect(formatCompactCurrency(1500000000)).toBe('$1.50B');
    });

    it('should handle negative values correctly', () => {
      expect(formatCompactCurrency(-1500)).toBe('-$1.50K');
      expect(formatCompactCurrency(-2300000)).toBe('-$2.30M');
      expect(formatCompactCurrency(-500)).toBe('-$500.00');
    });

    it('should handle non-finite values', () => {
      expect(formatCompactCurrency(NaN)).toBe('$0.00');
      expect(formatCompactCurrency(Infinity)).toBe('$0.00');
      expect(formatCompactCurrency(-Infinity)).toBe('$0.00');
    });

    it('should handle non-finite values with decimals=0 (no trailing dot)', () => {
      expect(formatCompactCurrency(NaN, 0)).toBe('$0');
      expect(formatCompactCurrency(Infinity, 0)).toBe('$0');
    });

    it('should respect custom decimals', () => {
      expect(formatCompactCurrency(1500, 1)).toBe('$1.5K');
      expect(formatCompactCurrency(1500, 0)).toBe('$2K');
      expect(formatCompactCurrency(500, 3)).toBe('$500.000');
    });
  });

  describe('formatNumberWithSeparators', () => {
    it('should round fractional values to the nearest whole number by default', () => {
      expect(formatNumberWithSeparators(1234.4)).toBe('1,234');
      expect(formatNumberWithSeparators(1234.5)).toBe('1,235');
      expect(formatNumberWithSeparators(999.5)).toBe('1,000');
    });

    it('should format negative values with separators', () => {
      expect(formatNumberWithSeparators(-1234.4)).toBe('-1,234');
      expect(formatNumberWithSeparators(-1234.5)).toBe('-1,235');
    });

    it('should support explicit decimals when requested', () => {
      expect(formatNumberWithSeparators(1234.56, { decimals: 2 })).toBe(
        '1,234.56'
      );
    });

    it('should return a zero fallback for non-finite values', () => {
      expect(formatNumberWithSeparators(Number.NaN)).toBe('0');
      expect(formatNumberWithSeparators(Number.POSITIVE_INFINITY)).toBe('0');
      expect(formatNumberWithSeparators(Number.NEGATIVE_INFINITY)).toBe('0');
    });
  });

  describe('formatPercentage', () => {
    it('should format percentages as integers', () => {
      expect(formatPercentage(50)).toBe('50%');
      expect(formatPercentage(12.3)).toBe('12%');
      expect(formatPercentage(99.9)).toBe('100%');
    });
  });

  describe('sanitizeId', () => {
    it('should convert to lowercase and remove special characters', () => {
      expect(sanitizeId('My User ID!')).toBe('my-user-id');
      expect(sanitizeId('Test@User#123')).toBe('testuser123');
    });

    it('should handle null/undefined', () => {
      expect(sanitizeId(null)).toBe('unknown');
      expect(sanitizeId(undefined)).toBe('unknown');
    });

    it('should replace spaces with hyphens', () => {
      expect(sanitizeId('hello world')).toBe('hello-world');
      expect(sanitizeId('multiple   spaces')).toBe('multiple-spaces');
    });

    it('should preserve underscores', () => {
      expect(sanitizeId('user_123')).toBe('user_123');
    });
  });
});
