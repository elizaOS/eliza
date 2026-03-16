/**
 * @module schedule-utils.test
 * @description Tests for schedule utility functions
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
} from '../scheduler/schedule-utils.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';

describe('schedule-utils', () => {
  describe('parseDuration', () => {
    it('parses seconds', () => {
      expect(parseDuration('30s')).toBe(30000);
      expect(parseDuration('30 seconds')).toBe(30000);
      expect(parseDuration('1 second')).toBe(1000);
    });

    it('parses minutes', () => {
      expect(parseDuration('5m')).toBe(300000);
      expect(parseDuration('5 minutes')).toBe(300000);
      expect(parseDuration('1 minute')).toBe(60000);
    });

    it('parses hours', () => {
      expect(parseDuration('2h')).toBe(7200000);
      expect(parseDuration('2 hours')).toBe(7200000);
      expect(parseDuration('1 hour')).toBe(3600000);
    });

    it('parses days', () => {
      expect(parseDuration('1d')).toBe(86400000);
      expect(parseDuration('2 days')).toBe(172800000);
    });

    it('returns null for invalid input', () => {
      expect(parseDuration('invalid')).toBeNull();
      expect(parseDuration('')).toBeNull();
      expect(parseDuration('5 weeks')).toBeNull(); // weeks not supported yet
    });
  });

  describe('validateAtSchedule', () => {
    it('accepts valid ISO timestamps', () => {
      expect(validateAtSchedule('2024-12-31T23:59:59Z')).toBeNull();
      expect(validateAtSchedule('2024-01-01T00:00:00.000Z')).toBeNull();
    });

    it('rejects invalid timestamps', () => {
      expect(validateAtSchedule('invalid')).not.toBeNull();
      expect(validateAtSchedule('not-a-date')).not.toBeNull();
    });
  });

  describe('validateEverySchedule', () => {
    it('accepts valid intervals', () => {
      expect(validateEverySchedule(60000, DEFAULT_CRON_CONFIG)).toBeNull();
      expect(validateEverySchedule(10000, DEFAULT_CRON_CONFIG)).toBeNull();
    });

    it('rejects intervals below minimum', () => {
      expect(validateEverySchedule(5000, DEFAULT_CRON_CONFIG)).not.toBeNull();
      expect(validateEverySchedule(1000, DEFAULT_CRON_CONFIG)).not.toBeNull();
    });

    it('rejects invalid values', () => {
      expect(validateEverySchedule(0, DEFAULT_CRON_CONFIG)).not.toBeNull();
      expect(validateEverySchedule(-1000, DEFAULT_CRON_CONFIG)).not.toBeNull();
      expect(validateEverySchedule(NaN, DEFAULT_CRON_CONFIG)).not.toBeNull();
    });
  });

  describe('validateCronExpression', () => {
    it('accepts valid cron expressions', () => {
      expect(validateCronExpression('* * * * *')).toBeNull();
      expect(validateCronExpression('0 9 * * 1-5')).toBeNull();
      expect(validateCronExpression('0 0 1 * *')).toBeNull();
    });

    it('accepts expressions with timezone', () => {
      expect(validateCronExpression('0 9 * * *', 'America/New_York')).toBeNull();
      expect(validateCronExpression('0 9 * * *', 'Europe/London')).toBeNull();
    });

    it('rejects empty expressions', () => {
      expect(validateCronExpression('')).not.toBeNull();
      expect(validateCronExpression('   ')).not.toBeNull();
    });
  });

  describe('validateSchedule', () => {
    it('validates at schedules', () => {
      expect(
        validateSchedule(
          { kind: 'at', at: '2030-12-31T23:59:59Z' },
          DEFAULT_CRON_CONFIG
        )
      ).toBeNull();
    });

    it('validates every schedules', () => {
      expect(
        validateSchedule(
          { kind: 'every', everyMs: 60000 },
          DEFAULT_CRON_CONFIG
        )
      ).toBeNull();
    });

    it('validates cron schedules', () => {
      expect(
        validateSchedule(
          { kind: 'cron', expr: '0 9 * * *' },
          DEFAULT_CRON_CONFIG
        )
      ).toBeNull();
    });
  });

  describe('computeNextRunAtMs', () => {
    it('computes next run for at schedules', () => {
      const futureTime = Date.now() + 3600000; // 1 hour from now
      const schedule = { kind: 'at' as const, at: new Date(futureTime).toISOString() };
      const result = computeNextRunAtMs(schedule, Date.now());

      expect(result).toBeDefined();
      expect(Math.abs(result! - futureTime)).toBeLessThan(1000);
    });

    it('returns undefined for past at schedules', () => {
      const pastTime = Date.now() - 3600000; // 1 hour ago
      const schedule = { kind: 'at' as const, at: new Date(pastTime).toISOString() };
      const result = computeNextRunAtMs(schedule, Date.now());

      expect(result).toBeUndefined();
    });

    it('computes next run for every schedules', () => {
      const nowMs = Date.now();
      const schedule = { kind: 'every' as const, everyMs: 60000, anchorMs: nowMs };
      const result = computeNextRunAtMs(schedule, nowMs + 1);

      expect(result).toBeDefined();
      expect(result).toBe(nowMs + 60000);
    });

    it('computes next run for cron schedules', () => {
      const schedule = { kind: 'cron' as const, expr: '* * * * *' };
      const result = computeNextRunAtMs(schedule, Date.now());

      expect(result).toBeDefined();
      expect(result).toBeGreaterThan(Date.now());
    });
  });

  describe('isJobDue', () => {
    it('returns true when past scheduled time', () => {
      const scheduledTime = Date.now() - 1000;
      expect(isJobDue(scheduledTime, Date.now())).toBe(true);
    });

    it('returns true within tolerance window', () => {
      const scheduledTime = Date.now() + 500; // 500ms in future
      expect(isJobDue(scheduledTime, Date.now(), 1000)).toBe(true);
    });

    it('returns false when not due', () => {
      const scheduledTime = Date.now() + 60000; // 1 minute in future
      expect(isJobDue(scheduledTime, Date.now())).toBe(false);
    });

    it('returns false for undefined schedule', () => {
      expect(isJobDue(undefined, Date.now())).toBe(false);
    });
  });

  describe('formatSchedule', () => {
    it('formats at schedules', () => {
      const schedule = { kind: 'at' as const, at: '2024-12-31T23:59:59Z' };
      const result = formatSchedule(schedule);
      expect(result).toContain('once at');
    });

    it('formats every schedules', () => {
      expect(formatSchedule({ kind: 'every', everyMs: 60000 })).toBe('every 1 minute');
      expect(formatSchedule({ kind: 'every', everyMs: 3600000 })).toBe('every 1 hour');
      expect(formatSchedule({ kind: 'every', everyMs: 86400000 })).toBe('every 1 day');
      expect(formatSchedule({ kind: 'every', everyMs: 300000 })).toBe('every 5 minutes');
    });

    it('formats cron schedules', () => {
      expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *' })).toBe('cron: 0 9 * * *');
      expect(formatSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe(
        'cron: 0 9 * * * (UTC)'
      );
    });
  });

  describe('parseScheduleDescription', () => {
    it('parses "in X duration" patterns', () => {
      const nowMs = Date.now();
      const result = parseScheduleDescription('in 5 minutes', nowMs);

      expect(result).not.toBeNull();
      expect(result?.kind).toBe('at');
      if (result?.kind === 'at') {
        const scheduled = new Date(result.at).getTime();
        expect(Math.abs(scheduled - (nowMs + 300000))).toBeLessThan(1000);
      }
    });

    it('parses "every X duration" patterns', () => {
      const result = parseScheduleDescription('every 1 hour');

      expect(result).not.toBeNull();
      expect(result?.kind).toBe('every');
      if (result?.kind === 'every') {
        expect(result.everyMs).toBe(3600000);
      }
    });

    it('parses cron expressions', () => {
      const result = parseScheduleDescription('0 9 * * *');

      expect(result).not.toBeNull();
      expect(result?.kind).toBe('cron');
      if (result?.kind === 'cron') {
        expect(result.expr).toBe('0 9 * * *');
      }
    });

    it('returns undefined for unparseable input', () => {
      expect(parseScheduleDescription('hello world')).toBeUndefined();
      expect(parseScheduleDescription('')).toBeUndefined();
    });
  });
});
