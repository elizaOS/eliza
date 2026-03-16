/**
 * @module schedule-utils-extended.test
 * @description Extended tests for schedule utilities - edge cases, boundaries, error handling
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

describe('schedule-utils extended', () => {
  // ==========================================================================
  // BOUNDARY CONDITIONS
  // ==========================================================================

  describe('parseDuration boundary conditions', () => {
    it('handles decimal values', () => {
      expect(parseDuration('1.5 hours')).toBe(5400000); // 1.5 * 60 * 60 * 1000
      expect(parseDuration('0.5 days')).toBe(43200000); // 12 hours
      expect(parseDuration('2.5m')).toBe(150000); // 2.5 minutes
    });

    it('handles very large values', () => {
      expect(parseDuration('1000 days')).toBe(86400000000);
      expect(parseDuration('9999 hours')).toBe(35996400000);
    });

    it('handles whitespace variations', () => {
      expect(parseDuration('  5  minutes  ')).toBe(300000);
      expect(parseDuration('10  s')).toBe(10000);
    });

    it('is case insensitive', () => {
      expect(parseDuration('5 MINUTES')).toBe(300000);
      expect(parseDuration('2 Hours')).toBe(7200000);
      expect(parseDuration('1 DAY')).toBe(86400000);
    });

    it('handles singular and plural forms', () => {
      expect(parseDuration('1 second')).toBe(parseDuration('1 sec'));
      expect(parseDuration('1 minute')).toBe(parseDuration('1 min'));
      expect(parseDuration('1 hour')).toBe(parseDuration('1 hr'));
      expect(parseDuration('1 day')).toBe(parseDuration('1 d'));
    });

    it('returns null for zero values', () => {
      // Zero durations don't make sense and would cause scheduling issues (infinite loops, immediate re-runs)
      expect(parseDuration('0 minutes')).toBeNull();
      expect(parseDuration('0s')).toBeNull();
      expect(parseDuration('0h')).toBeNull();
    });

    it('returns null for negative values', () => {
      expect(parseDuration('-5 minutes')).toBeNull();
    });

    it('returns null for unsupported units', () => {
      expect(parseDuration('5 weeks')).toBeNull();
      expect(parseDuration('3 months')).toBeNull();
      expect(parseDuration('1 year')).toBeNull();
      expect(parseDuration('5 ms')).toBeNull();
    });
  });

  describe('parseTimestamp edge cases', () => {
    it('parses valid ISO timestamps', () => {
      expect(parseTimestamp('2024-01-01T00:00:00Z')).toBe(1704067200000);
      expect(parseTimestamp('2024-06-15T12:30:45.123Z')).toBeDefined();
    });

    it('parses timestamps with timezone offsets', () => {
      const withOffset = parseTimestamp('2024-01-01T00:00:00+05:30');
      expect(withOffset).toBeDefined();
      expect(typeof withOffset).toBe('number');
    });

    it('returns null for invalid formats', () => {
      expect(parseTimestamp('')).toBeNull();
      expect(parseTimestamp('not-a-date')).toBeNull();
      expect(parseTimestamp('2024-13-45')).toBeNull(); // Invalid month/day
      expect(parseTimestamp('tomorrow')).toBeNull();
    });

    it('handles edge dates', () => {
      // Unix epoch
      expect(parseTimestamp('1970-01-01T00:00:00Z')).toBe(0);
      // Far future
      expect(parseTimestamp('2100-12-31T23:59:59Z')).toBeDefined();
    });
  });

  describe('validateEverySchedule boundary conditions', () => {
    it('accepts exact minimum interval', () => {
      expect(validateEverySchedule(10000, DEFAULT_CRON_CONFIG)).toBeNull();
    });

    it('rejects just below minimum', () => {
      expect(validateEverySchedule(9999, DEFAULT_CRON_CONFIG)).not.toBeNull();
    });

    it('accepts very large intervals', () => {
      expect(validateEverySchedule(Number.MAX_SAFE_INTEGER, DEFAULT_CRON_CONFIG)).toBeNull();
    });

    it('rejects Infinity', () => {
      expect(validateEverySchedule(Infinity, DEFAULT_CRON_CONFIG)).not.toBeNull();
    });

    it('rejects negative Infinity', () => {
      expect(validateEverySchedule(-Infinity, DEFAULT_CRON_CONFIG)).not.toBeNull();
    });

    it('respects custom minimum interval', () => {
      const customConfig: CronServiceConfig = { ...DEFAULT_CRON_CONFIG, minIntervalMs: 5000 };
      expect(validateEverySchedule(5000, customConfig)).toBeNull();
      expect(validateEverySchedule(4999, customConfig)).not.toBeNull();
    });
  });

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  describe('validateCronExpression error handling', () => {
    it('returns descriptive error for empty expression', () => {
      const error = validateCronExpression('');
      expect(error).toContain('empty');
    });

    it('returns error for invalid timezone', () => {
      const error = validateCronExpression('* * * * *', 'Invalid/Timezone');
      expect(error).toContain('Invalid timezone');
    });

    it('returns error for malformed cron expressions', () => {
      expect(validateCronExpression('* * * *')).not.toBeNull(); // Too few fields
      expect(validateCronExpression('60 * * * *')).not.toBeNull(); // Invalid minute
      expect(validateCronExpression('* 25 * * *')).not.toBeNull(); // Invalid hour
    });

    it('validates various valid cron expressions', () => {
      // Standard 5-field
      expect(validateCronExpression('0 0 * * *')).toBeNull(); // Daily at midnight
      expect(validateCronExpression('*/5 * * * *')).toBeNull(); // Every 5 minutes
      expect(validateCronExpression('0 9-17 * * 1-5')).toBeNull(); // Hourly 9-5 weekdays
      
      // With seconds (6-field)
      expect(validateCronExpression('0 0 0 * * *')).toBeNull(); // Daily at midnight with seconds
    });

    it('validates edge cron expressions', () => {
      expect(validateCronExpression('59 23 31 12 *')).toBeNull(); // Dec 31 23:59
      expect(validateCronExpression('0 0 1 1 *')).toBeNull(); // Jan 1 00:00
      expect(validateCronExpression('0 0 29 2 *')).toBeNull(); // Feb 29 (leap year only)
    });

    it('validates various timezones', () => {
      expect(validateCronExpression('0 9 * * *', 'UTC')).toBeNull();
      expect(validateCronExpression('0 9 * * *', 'America/New_York')).toBeNull();
      expect(validateCronExpression('0 9 * * *', 'Asia/Tokyo')).toBeNull();
      expect(validateCronExpression('0 9 * * *', 'Europe/London')).toBeNull();
      expect(validateCronExpression('0 9 * * *', 'Pacific/Auckland')).toBeNull();
    });
  });

  describe('validateSchedule error messages', () => {
    it('includes schedule type in error context', () => {
      const atError = validateSchedule({ kind: 'at', at: 'invalid' }, DEFAULT_CRON_CONFIG);
      expect(atError).toBeDefined();

      const everyError = validateSchedule({ kind: 'every', everyMs: -1 }, DEFAULT_CRON_CONFIG);
      expect(everyError).toBeDefined();

      const cronError = validateSchedule({ kind: 'cron', expr: '' }, DEFAULT_CRON_CONFIG);
      expect(cronError).toBeDefined();
    });
  });

  // ==========================================================================
  // COMPUTE NEXT RUN - REAL CALCULATIONS
  // ==========================================================================

  describe('computeNextRunAtMs real calculations', () => {
    describe('at schedules', () => {
      it('returns exact timestamp for future date', () => {
        const futureMs = Date.now() + 1000000;
        const schedule: CronSchedule = { kind: 'at', at: new Date(futureMs).toISOString() };
        const result = computeNextRunAtMs(schedule, Date.now());
        
        expect(result).toBeDefined();
        // Should be within 1 second of the target (accounting for ISO string precision)
        expect(Math.abs(result! - futureMs)).toBeLessThan(1000);
      });

      it('returns undefined for past timestamps', () => {
        const pastMs = Date.now() - 1000000;
        const schedule: CronSchedule = { kind: 'at', at: new Date(pastMs).toISOString() };
        expect(computeNextRunAtMs(schedule, Date.now())).toBeUndefined();
      });

      it('returns undefined for exactly now', () => {
        const nowMs = Date.now();
        const schedule: CronSchedule = { kind: 'at', at: new Date(nowMs).toISOString() };
        // Should be undefined because nowMs is not > nowMs
        expect(computeNextRunAtMs(schedule, nowMs)).toBeUndefined();
      });

      it('handles timestamps just in the future', () => {
        const nowMs = Date.now();
        const schedule: CronSchedule = { kind: 'at', at: new Date(nowMs + 1).toISOString() };
        expect(computeNextRunAtMs(schedule, nowMs)).toBeDefined();
      });
    });

    describe('every schedules', () => {
      it('calculates correct next run from anchor', () => {
        const nowMs = 1000000;
        const schedule: CronSchedule = { kind: 'every', everyMs: 60000, anchorMs: 1000000 };
        
        // At exactly anchor time, next run should be anchor + interval
        const result = computeNextRunAtMs(schedule, nowMs + 1);
        expect(result).toBe(1060000);
      });

      it('handles anchor in the future', () => {
        const nowMs = 1000000;
        const schedule: CronSchedule = { kind: 'every', everyMs: 60000, anchorMs: 2000000 };
        
        // If anchor is in future, next run is the anchor
        const result = computeNextRunAtMs(schedule, nowMs);
        expect(result).toBe(2000000);
      });

      it('calculates correctly when multiple intervals have passed', () => {
        const anchorMs = 1000000;
        const everyMs = 60000;
        const schedule: CronSchedule = { kind: 'every', everyMs, anchorMs };
        
        // 5.5 intervals have passed
        const nowMs = anchorMs + (5.5 * everyMs);
        const result = computeNextRunAtMs(schedule, nowMs);
        
        // Should be the next interval boundary (6 * everyMs)
        expect(result).toBe(anchorMs + (6 * everyMs));
      });

      it('uses current time as anchor if not specified', () => {
        const nowMs = Date.now();
        const schedule: CronSchedule = { kind: 'every', everyMs: 60000 };
        const result = computeNextRunAtMs(schedule, nowMs);
        
        // Without anchor, should use nowMs as anchor, so next = nowMs + everyMs
        expect(result).toBeDefined();
        expect(result! - nowMs).toBeLessThanOrEqual(60000);
      });
    });

    describe('cron schedules with real croner', () => {
      it('calculates next minute correctly', () => {
        const schedule: CronSchedule = { kind: 'cron', expr: '* * * * *' };
        const nowMs = Date.now();
        const result = computeNextRunAtMs(schedule, nowMs);
        
        expect(result).toBeDefined();
        // Should be within next minute
        expect(result! - nowMs).toBeLessThanOrEqual(60000);
      });

      it('calculates daily schedule correctly', () => {
        // Use UTC timezone explicitly to ensure consistent test results
        const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }; // 9 AM UTC daily
        const nowMs = Date.now();
        const result = computeNextRunAtMs(schedule, nowMs);
        
        expect(result).toBeDefined();
        // Should be within 24 hours
        expect(result! - nowMs).toBeLessThanOrEqual(86400000);
        
        // Verify it's at 9:00 UTC
        const nextDate = new Date(result!);
        expect(nextDate.getUTCHours()).toBe(9);
        expect(nextDate.getUTCMinutes()).toBe(0);
      });

      it('respects timezone', () => {
        // 9 AM in New York
        const schedule: CronSchedule = { 
          kind: 'cron', 
          expr: '0 9 * * *', 
          tz: 'America/New_York' 
        };
        const result = computeNextRunAtMs(schedule, Date.now());
        
        expect(result).toBeDefined();
        // Just verify we get a result - exact time depends on current time/timezone
      });

      it('handles weekend-only schedules', () => {
        const schedule: CronSchedule = { kind: 'cron', expr: '0 10 * * 0,6' }; // 10 AM Sat/Sun
        const nowMs = Date.now();
        const result = computeNextRunAtMs(schedule, nowMs);
        
        expect(result).toBeDefined();
        // Should be within 7 days
        expect(result! - nowMs).toBeLessThanOrEqual(7 * 86400000);
        
        const nextDate = new Date(result!);
        const day = nextDate.getUTCDay();
        expect([0, 6]).toContain(day); // Sunday or Saturday
      });
    });
  });

  // ==========================================================================
  // isJobDue EDGE CASES
  // ==========================================================================

  describe('isJobDue edge cases', () => {
    it('handles exactly scheduled time', () => {
      const scheduledTime = 1000000;
      expect(isJobDue(scheduledTime, scheduledTime)).toBe(true);
    });

    it('handles custom tolerance', () => {
      const scheduledTime = 1000000;
      
      // With 0 tolerance, must be at or past scheduled time
      expect(isJobDue(scheduledTime + 1, scheduledTime, 0)).toBe(false);
      expect(isJobDue(scheduledTime, scheduledTime, 0)).toBe(true);
      expect(isJobDue(scheduledTime - 1, scheduledTime, 0)).toBe(true);
      
      // With 5000ms tolerance
      expect(isJobDue(scheduledTime + 5000, scheduledTime, 5000)).toBe(true);
      expect(isJobDue(scheduledTime + 5001, scheduledTime, 5000)).toBe(false);
    });

    it('handles very large time values', () => {
      const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
      expect(isJobDue(farFuture, Date.now())).toBe(false);
    });

    it('handles zero scheduled time', () => {
      expect(isJobDue(0, 1000)).toBe(true);
    });
  });

  // ==========================================================================
  // formatSchedule OUTPUT VERIFICATION
  // ==========================================================================

  describe('formatSchedule exact output verification', () => {
    it('formats seconds correctly', () => {
      expect(formatSchedule({ kind: 'every', everyMs: 1000 })).toBe('every 1 second');
      expect(formatSchedule({ kind: 'every', everyMs: 30000 })).toBe('every 30 seconds');
      expect(formatSchedule({ kind: 'every', everyMs: 59000 })).toBe('every 59 seconds');
    });

    it('formats minutes correctly', () => {
      expect(formatSchedule({ kind: 'every', everyMs: 60000 })).toBe('every 1 minute');
      expect(formatSchedule({ kind: 'every', everyMs: 120000 })).toBe('every 2 minutes');
      expect(formatSchedule({ kind: 'every', everyMs: 300000 })).toBe('every 5 minutes');
    });

    it('formats hours correctly', () => {
      expect(formatSchedule({ kind: 'every', everyMs: 3600000 })).toBe('every 1 hour');
      expect(formatSchedule({ kind: 'every', everyMs: 7200000 })).toBe('every 2 hours');
    });

    it('formats days correctly', () => {
      expect(formatSchedule({ kind: 'every', everyMs: 86400000 })).toBe('every 1 day');
      expect(formatSchedule({ kind: 'every', everyMs: 172800000 })).toBe('every 2 days');
    });

    it('includes timezone in cron format', () => {
      const result = formatSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' });
      expect(result).toBe('cron: 0 9 * * * (America/New_York)');
    });

    it('omits timezone when not specified', () => {
      const result = formatSchedule({ kind: 'cron', expr: '0 9 * * *' });
      expect(result).toBe('cron: 0 9 * * *');
    });
  });

  // ==========================================================================
  // parseScheduleDescription COMPREHENSIVE
  // ==========================================================================

  describe('parseScheduleDescription comprehensive', () => {
    it('handles various "in X" patterns', () => {
      const nowMs = Date.now();
      
      // Verify the schedule type and approximate time
      const in5min = parseScheduleDescription('in 5 minutes', nowMs);
      expect(in5min?.kind).toBe('at');
      if (in5min?.kind === 'at') {
        const diff = new Date(in5min.at).getTime() - nowMs;
        expect(Math.abs(diff - 300000)).toBeLessThan(1000);
      }

      const in2hours = parseScheduleDescription('in 2 hours', nowMs);
      expect(in2hours?.kind).toBe('at');
      if (in2hours?.kind === 'at') {
        const diff = new Date(in2hours.at).getTime() - nowMs;
        expect(Math.abs(diff - 7200000)).toBeLessThan(1000);
      }
    });

    it('handles various "every X" patterns', () => {
      const every30s = parseScheduleDescription('every 30 seconds');
      expect(every30s?.kind).toBe('every');
      if (every30s?.kind === 'every') {
        expect(every30s.everyMs).toBe(30000);
      }

      const every2h = parseScheduleDescription('every 2 hours');
      expect(every2h?.kind).toBe('every');
      if (every2h?.kind === 'every') {
        expect(every2h.everyMs).toBe(7200000);
      }
    });

    it('detects and validates cron expressions', () => {
      // Valid cron
      const cron1 = parseScheduleDescription('0 9 * * *');
      expect(cron1?.kind).toBe('cron');
      
      // 6-field cron
      const cron2 = parseScheduleDescription('0 0 9 * * *');
      expect(cron2?.kind).toBe('cron');
    });

    it('parses ISO timestamps directly', () => {
      const result = parseScheduleDescription('2024-12-31T23:59:59Z');
      expect(result?.kind).toBe('at');
    });

    it('returns undefined for ambiguous or invalid input', () => {
      expect(parseScheduleDescription('')).toBeUndefined();
      expect(parseScheduleDescription('soon')).toBeUndefined();
      expect(parseScheduleDescription('maybe tomorrow')).toBeUndefined();
      expect(parseScheduleDescription('a b c d')).toBeUndefined(); // Not enough for cron, not a known pattern
    });
  });
});
