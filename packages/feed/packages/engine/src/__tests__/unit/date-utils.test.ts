/**
 * Date Utilities Unit Tests
 *
 * Tests for date parsing and manipulation utilities.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  extractDayFromEvent,
  extractDayFromPost,
  extractDayFromTimestamp,
  getGameDayNumber,
  getTodayDateString,
  toDateString,
  toSafeDayNumber,
} from '../../utils/date-utils';

// Mock the logger to prevent actual logging during tests
mock.module('@babylon/shared', () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

describe('Date Utilities', () => {
  describe('extractDayFromTimestamp', () => {
    test('extracts day from ISO format timestamp', () => {
      expect(extractDayFromTimestamp('2025-10-15T12:00:00Z')).toBe(15);
      expect(extractDayFromTimestamp('2025-10-01T00:00:00Z')).toBe(1);
      expect(extractDayFromTimestamp('2025-10-31T23:59:59Z')).toBe(31);
    });

    test('extracts day from generic date format', () => {
      expect(extractDayFromTimestamp('2024-05-20T10:30:00Z')).toBe(20);
    });

    test('returns 0 for invalid timestamp', () => {
      expect(extractDayFromTimestamp('invalid')).toBe(0);
      expect(extractDayFromTimestamp('')).toBe(0);
    });
  });

  describe('extractDayFromEvent', () => {
    test('returns event.day if present', () => {
      expect(extractDayFromEvent({ day: 5 })).toBe(5);
    });

    test('extracts day from timestamp string', () => {
      expect(extractDayFromEvent({ timestamp: '2025-10-15T12:00:00Z' })).toBe(
        15
      );
    });

    test('extracts day from Date object', () => {
      expect(
        extractDayFromEvent({ timestamp: new Date('2025-10-15T12:00:00Z') })
      ).toBe(15);
    });

    test('prefers day over timestamp', () => {
      expect(
        extractDayFromEvent({
          day: 7,
          timestamp: '2025-10-15T12:00:00Z',
        })
      ).toBe(7);
    });

    test('returns 0 when no date info available', () => {
      expect(extractDayFromEvent({})).toBe(0);
    });
  });

  describe('extractDayFromPost', () => {
    test('returns post.day if present', () => {
      expect(extractDayFromPost({ day: 3 })).toBe(3);
    });

    test('extracts day from createdAt string', () => {
      expect(extractDayFromPost({ createdAt: '2025-10-20T08:00:00Z' })).toBe(
        20
      );
    });

    test('extracts day from Date object', () => {
      expect(
        extractDayFromPost({ createdAt: new Date('2025-10-20T08:00:00Z') })
      ).toBe(20);
    });

    test('returns 0 when no date info available', () => {
      expect(extractDayFromPost({})).toBe(0);
    });
  });

  describe('getGameDayNumber', () => {
    const startedAt = new Date('2025-01-01T00:00:00Z');

    test('returns day 1 for same day', () => {
      const timestamp = new Date('2025-01-01T12:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(1);
    });

    test('returns day 2 for 24 hours later', () => {
      const timestamp = new Date('2025-01-02T00:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(2);
    });

    test('returns day 10 for 9 days later', () => {
      const timestamp = new Date('2025-01-10T12:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(10);
    });

    test('clamps to day 1 for timestamps before startedAt', () => {
      const timestamp = new Date('2024-12-31T12:00:00Z');
      expect(getGameDayNumber(startedAt, timestamp)).toBe(1);
    });
  });

  describe('toSafeDayNumber', () => {
    test('returns valid day numbers unchanged', () => {
      expect(toSafeDayNumber(1)).toBe(1);
      expect(toSafeDayNumber(100)).toBe(100);
      expect(toSafeDayNumber(365)).toBe(365);
    });

    test('returns undefined for zero or negative', () => {
      expect(toSafeDayNumber(0)).toBeUndefined();
      expect(toSafeDayNumber(-1)).toBeUndefined();
    });

    test('returns undefined for NaN and Infinity', () => {
      expect(toSafeDayNumber(NaN)).toBeUndefined();
      expect(toSafeDayNumber(Infinity)).toBeUndefined();
    });

    test('returns undefined for values exceeding INT max', () => {
      expect(toSafeDayNumber(2147483648)).toBeUndefined();
    });

    test('returns max INT value when at boundary', () => {
      expect(toSafeDayNumber(2147483647)).toBe(2147483647);
    });

    test('accepts floating-point values', () => {
      // Documents current behavior: floats are accepted (not rejected)
      expect(toSafeDayNumber(1.5)).toBe(1.5);
      expect(toSafeDayNumber(99.9)).toBe(99.9);
    });
  });

  describe('toDateString', () => {
    test('converts Date to YYYY-MM-DD format', () => {
      const date = new Date('2025-01-15T12:30:45.123Z');
      expect(toDateString(date)).toBe('2025-01-15');
    });

    test('converts ISO string to YYYY-MM-DD format', () => {
      expect(toDateString('2025-06-20T08:00:00Z')).toBe('2025-06-20');
    });

    test('handles end of month dates', () => {
      expect(toDateString(new Date('2025-01-31T23:59:59Z'))).toBe('2025-01-31');
    });
  });

  describe('getTodayDateString', () => {
    test('returns a valid date string format', () => {
      const result = getTodayDateString();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("returns today's date", () => {
      const today = new Date();
      const expected = today.toISOString().split('T')[0];
      expect(getTodayDateString()).toBe(expected);
    });
  });
});
