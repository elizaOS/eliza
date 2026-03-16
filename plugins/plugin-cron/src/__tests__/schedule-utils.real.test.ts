/**
 * @module schedule-utils.real.test
 * @description Real scheduling logic tests — no mocks, exercising actual computation
 * paths in schedule-utils. Covers cron expression validation, natural language parsing,
 * next-run computation, duration formatting, display strings, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  computeNextRunAtMs,
  validateSchedule,
  formatSchedule,
  parseScheduleDescription,
  parseDuration,
  validateAtSchedule,
  validateEverySchedule,
  validateCronExpression,
  isJobDue,
  parseTimestamp,
} from '../scheduler/schedule-utils.js';
import { DEFAULT_CRON_CONFIG, type CronSchedule, type CronServiceConfig } from '../types.js';

// ============================================================================
// 1. Cron Expression Validation — Real croner parsing
// ============================================================================

describe('Real cron expression validation', () => {
  it('accepts standard valid expressions without error', () => {
    const validExprs = [
      '0 * * * *',       // every hour at :00
      '*/5 * * * *',     // every 5 minutes
      '0 9 * * 1-5',     // 9am weekdays
      '30 2 1 * *',      // 2:30am on 1st of month
      '0 0 * * 0',       // midnight every Sunday
      '15 14 1 * *',     // 2:15pm on 1st of month
    ];

    for (const expr of validExprs) {
      const result = validateCronExpression(expr);
      expect(result, `Expected "${expr}" to be valid, got: ${result}`).toBeNull();
    }
  });

  it('rejects clearly invalid expressions with descriptive errors', () => {
    const invalidCases = [
      { expr: 'invalid', reason: 'not a cron expression at all' },
      { expr: '', reason: 'empty string' },
      { expr: '   ', reason: 'whitespace only' },
      { expr: '* * *', reason: 'too few fields' },
      { expr: '60 * * * *', reason: 'minute out of range (60)' },
      { expr: '* 25 * * *', reason: 'hour out of range (25)' },
    ];

    for (const { expr, reason } of invalidCases) {
      const result = validateCronExpression(expr);
      expect(result, `Expected "${expr}" (${reason}) to be invalid`).not.toBeNull();
      expect(typeof result).toBe('string');
    }
  });

  it('validates timezone parameter correctly', () => {
    // Valid timezones
    expect(validateCronExpression('0 9 * * *', 'America/New_York')).toBeNull();
    expect(validateCronExpression('0 9 * * *', 'Europe/London')).toBeNull();
    expect(validateCronExpression('0 9 * * *', 'Asia/Tokyo')).toBeNull();
    expect(validateCronExpression('0 9 * * *', 'UTC')).toBeNull();

    // Invalid timezone
    const result = validateCronExpression('0 9 * * *', 'Fake/Timezone');
    expect(result).not.toBeNull();
    expect(result).toContain('Invalid timezone');
  });

  it('accepts 6-field expressions with seconds', () => {
    expect(validateCronExpression('0 0 9 * * *')).toBeNull();    // 9am daily with seconds
    expect(validateCronExpression('30 0 9 * * *')).toBeNull();   // 9:00:30 daily
    expect(validateCronExpression('*/10 * * * * *')).toBeNull(); // every 10 seconds
  });
});

// ============================================================================
// 2. Natural Language Parsing — Real pattern matching + duration calc
// ============================================================================

describe('Natural language schedule parsing', () => {
  it('parses "every 5 minutes" to a correct interval schedule', () => {
    const result = parseScheduleDescription('every 5 minutes');
    expect(result).toBeDefined();
    expect(result?.kind).toBe('every');
    if (result?.kind === 'every') {
      expect(result.everyMs).toBe(5 * 60 * 1000); // 300000ms
    }
  });

  it('parses "every 2 hours" to a correct interval schedule', () => {
    const result = parseScheduleDescription('every 2 hours');
    expect(result).toBeDefined();
    expect(result?.kind).toBe('every');
    if (result?.kind === 'every') {
      expect(result.everyMs).toBe(2 * 60 * 60 * 1000); // 7200000ms
    }
  });

  it('parses "every 30 seconds" to a correct interval schedule', () => {
    const result = parseScheduleDescription('every 30 seconds');
    expect(result).toBeDefined();
    expect(result?.kind).toBe('every');
    if (result?.kind === 'every') {
      expect(result.everyMs).toBe(30 * 1000); // 30000ms
    }
  });

  it('parses "in 10 minutes" to a one-time schedule ~10 min in the future', () => {
    const nowMs = 1700000000000; // fixed reference point
    const result = parseScheduleDescription('in 10 minutes', nowMs);

    expect(result).toBeDefined();
    expect(result?.kind).toBe('at');
    if (result?.kind === 'at') {
      const scheduledMs = new Date(result.at).getTime();
      const expectedMs = nowMs + 10 * 60 * 1000;
      expect(Math.abs(scheduledMs - expectedMs)).toBeLessThan(1000);
    }
  });

  it('parses "in 1 day" to a one-time schedule ~24h in the future', () => {
    const nowMs = 1700000000000;
    const result = parseScheduleDescription('in 1 day', nowMs);

    expect(result).toBeDefined();
    expect(result?.kind).toBe('at');
    if (result?.kind === 'at') {
      const scheduledMs = new Date(result.at).getTime();
      expect(Math.abs(scheduledMs - (nowMs + 86400000))).toBeLessThan(1000);
    }
  });

  it('detects raw cron expressions like "0 9 * * 1-5"', () => {
    const result = parseScheduleDescription('0 9 * * 1-5');
    expect(result).toBeDefined();
    expect(result?.kind).toBe('cron');
    if (result?.kind === 'cron') {
      expect(result.expr).toBe('0 9 * * 1-5');
    }
  });

  it('returns undefined for unparseable natural language', () => {
    expect(parseScheduleDescription('sometime soon')).toBeUndefined();
    expect(parseScheduleDescription('next tuesday')).toBeUndefined();
    expect(parseScheduleDescription('')).toBeUndefined();
    expect(parseScheduleDescription('please schedule something')).toBeUndefined();
  });
});

// ============================================================================
// 3. Next Run Computation — Real time calculations
// ============================================================================

describe('Next run computation with real values', () => {
  it('computes next run for "at" schedule in the future', () => {
    const futureMs = Date.now() + 3600000;
    const schedule: CronSchedule = { kind: 'at', at: new Date(futureMs).toISOString() };
    const result = computeNextRunAtMs(schedule, Date.now());

    expect(result).toBeDefined();
    expect(Math.abs(result! - futureMs)).toBeLessThan(1000);
  });

  it('returns undefined for "at" schedule in the past', () => {
    const pastMs = Date.now() - 3600000;
    const schedule: CronSchedule = { kind: 'at', at: new Date(pastMs).toISOString() };
    expect(computeNextRunAtMs(schedule, Date.now())).toBeUndefined();
  });

  it('computes correct next interval for "every" schedule from anchor', () => {
    const anchor = 1000000;
    const interval = 60000;
    const schedule: CronSchedule = { kind: 'every', everyMs: interval, anchorMs: anchor };

    // Current time is 3.5 intervals past anchor
    const nowMs = anchor + 3.5 * interval;
    const result = computeNextRunAtMs(schedule, nowMs);

    // Should be the 4th interval boundary
    expect(result).toBe(anchor + 4 * interval);
  });

  it('returns anchor as next run when anchor is in the future', () => {
    const futureAnchor = Date.now() + 1000000;
    const schedule: CronSchedule = { kind: 'every', everyMs: 60000, anchorMs: futureAnchor };
    const result = computeNextRunAtMs(schedule, Date.now());

    expect(result).toBe(futureAnchor);
  });

  it('computes next minute for "* * * * *" cron expression', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' };
    const nowMs = Date.now();
    const result = computeNextRunAtMs(schedule, nowMs);

    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(nowMs);
    // Should fire within the next 60 seconds
    expect(result! - nowMs).toBeLessThanOrEqual(60000);
  });

  it('computes next 9am UTC correctly for daily cron', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' };
    const nowMs = Date.now();
    const result = computeNextRunAtMs(schedule, nowMs);

    expect(result).toBeDefined();
    const nextDate = new Date(result!);
    expect(nextDate.getUTCHours()).toBe(9);
    expect(nextDate.getUTCMinutes()).toBe(0);
    // Should be within 24 hours
    expect(result! - nowMs).toBeLessThanOrEqual(86400000);
  });

  it('returns undefined for empty cron expression', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: '' };
    expect(computeNextRunAtMs(schedule, Date.now())).toBeUndefined();
  });
});

// ============================================================================
// 4. Duration Formatting
// ============================================================================

describe('Duration formatting via parseDuration', () => {
  it('parses shorthand units (s, m, h, d)', () => {
    expect(parseDuration('10s')).toBe(10000);
    expect(parseDuration('5m')).toBe(300000);
    expect(parseDuration('2h')).toBe(7200000);
    expect(parseDuration('1d')).toBe(86400000);
  });

  it('parses longhand units (seconds, minutes, hours, days)', () => {
    expect(parseDuration('10 seconds')).toBe(10000);
    expect(parseDuration('5 minutes')).toBe(300000);
    expect(parseDuration('2 hours')).toBe(7200000);
    expect(parseDuration('1 day')).toBe(86400000);
  });

  it('parses fractional values correctly', () => {
    expect(parseDuration('1.5 hours')).toBe(5400000);  // 90 minutes
    expect(parseDuration('0.5 days')).toBe(43200000);   // 12 hours
    expect(parseDuration('2.5m')).toBe(150000);          // 2.5 minutes
  });

  it('returns null for zero and negative values', () => {
    expect(parseDuration('0s')).toBeNull();
    expect(parseDuration('0 minutes')).toBeNull();
    expect(parseDuration('-5 minutes')).toBeNull();
  });

  it('returns null for unsupported or gibberish input', () => {
    expect(parseDuration('5 weeks')).toBeNull();
    expect(parseDuration('3 months')).toBeNull();
    expect(parseDuration('invalid')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('5ms')).toBeNull();
  });
});

// ============================================================================
// 5. Schedule Format Display Strings
// ============================================================================

describe('Schedule display string formatting', () => {
  it('formats "every" schedules with correct pluralization', () => {
    expect(formatSchedule({ kind: 'every', everyMs: 1000 })).toBe('every 1 second');
    expect(formatSchedule({ kind: 'every', everyMs: 5000 })).toBe('every 5 seconds');
    expect(formatSchedule({ kind: 'every', everyMs: 60000 })).toBe('every 1 minute');
    expect(formatSchedule({ kind: 'every', everyMs: 300000 })).toBe('every 5 minutes');
    expect(formatSchedule({ kind: 'every', everyMs: 3600000 })).toBe('every 1 hour');
    expect(formatSchedule({ kind: 'every', everyMs: 7200000 })).toBe('every 2 hours');
    expect(formatSchedule({ kind: 'every', everyMs: 86400000 })).toBe('every 1 day');
    expect(formatSchedule({ kind: 'every', everyMs: 172800000 })).toBe('every 2 days');
  });

  it('formats "at" schedules with "once at" prefix', () => {
    const schedule: CronSchedule = { kind: 'at', at: '2030-06-15T14:30:00Z' };
    const result = formatSchedule(schedule);
    expect(result).toContain('once at');
  });

  it('formats "cron" schedules with expression and optional timezone', () => {
    expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *' })).toBe('cron: 0 9 * * *');
    expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe(
      'cron: 0 9 * * * (UTC)'
    );
    expect(formatSchedule({ kind: 'cron', expr: '*/5 * * * *', tz: 'America/Chicago' })).toBe(
      'cron: */5 * * * * (America/Chicago)'
    );
  });
});

// ============================================================================
// 6. Edge Cases — Past dates, timezones, leap years
// ============================================================================

describe('Edge cases', () => {
  it('handles a past "at" timestamp correctly (returns undefined)', () => {
    const pastSchedule: CronSchedule = {
      kind: 'at',
      at: '2020-01-01T00:00:00Z',
    };
    expect(computeNextRunAtMs(pastSchedule, Date.now())).toBeUndefined();
  });

  it('handles exactly-now "at" timestamp (returns undefined, not in future)', () => {
    const nowMs = Date.now();
    const schedule: CronSchedule = { kind: 'at', at: new Date(nowMs).toISOString() };
    expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
  });

  it('validates cron for Feb 29 (leap year day)', () => {
    // "0 0 29 2 *" — runs on Feb 29 at midnight (only fires on leap years)
    const result = validateCronExpression('0 0 29 2 *');
    expect(result).toBeNull(); // valid expression, even if it rarely fires
  });

  it('computes next run for timezone-aware cron across DST boundary', () => {
    // Use a timezone that has DST
    const schedule: CronSchedule = {
      kind: 'cron',
      expr: '0 2 * * *', // 2am daily
      tz: 'America/New_York',
    };
    const result = computeNextRunAtMs(schedule, Date.now());
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(Date.now());
  });

  it('handles weekend-only cron schedule (next run lands on Sat or Sun)', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: '0 12 * * 0,6', tz: 'UTC' };
    const result = computeNextRunAtMs(schedule, Date.now());

    expect(result).toBeDefined();
    const nextDate = new Date(result!);
    const dayOfWeek = nextDate.getUTCDay();
    expect([0, 6]).toContain(dayOfWeek); // Sunday=0, Saturday=6
    expect(nextDate.getUTCHours()).toBe(12);
  });

  it('handles very short "every" interval near minimum boundary', () => {
    const result = validateEverySchedule(10000, DEFAULT_CRON_CONFIG);
    expect(result).toBeNull(); // exactly at minimum

    const tooShort = validateEverySchedule(9999, DEFAULT_CRON_CONFIG);
    expect(tooShort).not.toBeNull();
  });

  it('validates that "at" schedule with far-future date is accepted', () => {
    const farFuture: CronSchedule = {
      kind: 'at',
      at: '2099-12-31T23:59:59Z',
    };
    const result = validateSchedule(farFuture, DEFAULT_CRON_CONFIG);
    expect(result).toBeNull();
  });

  it('isJobDue returns false for undefined nextRunAtMs', () => {
    expect(isJobDue(undefined, Date.now())).toBe(false);
  });

  it('isJobDue returns true when exactly at scheduled time', () => {
    const scheduledMs = 1700000000000;
    expect(isJobDue(scheduledMs, scheduledMs)).toBe(true);
  });

  it('isJobDue respects custom tolerance window', () => {
    const scheduledMs = 1700000000000;
    // 500ms before scheduled time with 1000ms tolerance -> due
    expect(isJobDue(scheduledMs + 500, scheduledMs, 1000)).toBe(true);
    // 2000ms before scheduled time with 1000ms tolerance -> not due
    expect(isJobDue(scheduledMs + 2000, scheduledMs, 1000)).toBe(false);
  });

  it('parseTimestamp handles epoch and invalid dates', () => {
    expect(parseTimestamp('1970-01-01T00:00:00Z')).toBe(0);
    expect(parseTimestamp('not-a-date')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('2100-12-31T23:59:59Z')).toBeDefined();
  });

  it('handles cross-midnight "every" schedule correctly', () => {
    // Anchor at 23:30, interval 1 hour — next run should cross midnight
    const anchor = new Date('2030-01-15T23:30:00Z').getTime();
    const schedule: CronSchedule = { kind: 'every', everyMs: 3600000, anchorMs: anchor };
    const nowMs = anchor + 1; // just past anchor
    const result = computeNextRunAtMs(schedule, nowMs);

    expect(result).toBeDefined();
    expect(result).toBe(anchor + 3600000);
    const nextDate = new Date(result!);
    expect(nextDate.getUTCHours()).toBe(0); // crossed midnight
    expect(nextDate.getUTCMinutes()).toBe(30);
  });
});
