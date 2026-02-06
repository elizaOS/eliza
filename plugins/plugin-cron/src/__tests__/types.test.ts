/**
 * @module types.test
 * @description Tests for type definitions and default values
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CRON_CONFIG,
  type CronSchedule,
  type CronPayload,
  type CronJob,
  type CronJobCreate,
  type CronJobPatch,
} from '../types.js';

describe('types', () => {
  describe('DEFAULT_CRON_CONFIG', () => {
    it('has sensible default values', () => {
      expect(DEFAULT_CRON_CONFIG.minIntervalMs).toBe(10000);
      expect(DEFAULT_CRON_CONFIG.maxJobsPerAgent).toBe(100);
      expect(DEFAULT_CRON_CONFIG.defaultTimeoutMs).toBe(300000);
      expect(DEFAULT_CRON_CONFIG.catchUpMissedJobs).toBe(false);
      expect(DEFAULT_CRON_CONFIG.catchUpWindowMs).toBe(3600000);
      expect(DEFAULT_CRON_CONFIG.timerCheckIntervalMs).toBe(1000);
    });
  });

  describe('CronSchedule types', () => {
    it('type-checks at schedules', () => {
      const schedule: CronSchedule = {
        kind: 'at',
        at: '2024-12-31T23:59:59Z',
      };
      expect(schedule.kind).toBe('at');
    });

    it('type-checks every schedules', () => {
      const schedule: CronSchedule = {
        kind: 'every',
        everyMs: 60000,
        anchorMs: Date.now(),
      };
      expect(schedule.kind).toBe('every');
    });

    it('type-checks cron schedules', () => {
      const schedule: CronSchedule = {
        kind: 'cron',
        expr: '0 9 * * *',
        tz: 'America/New_York',
      };
      expect(schedule.kind).toBe('cron');
    });
  });

  describe('CronPayload types', () => {
    it('type-checks prompt payloads', () => {
      const payload: CronPayload = {
        kind: 'prompt',
        text: 'Hello world',
        model: 'claude-3-sonnet',
        thinking: 'medium',
        timeoutSeconds: 60,
      };
      expect(payload.kind).toBe('prompt');
    });

    it('type-checks action payloads', () => {
      const payload: CronPayload = {
        kind: 'action',
        actionName: 'SEND_EMAIL',
        params: { to: 'test@example.com' },
      };
      expect(payload.kind).toBe('action');
    });

    it('type-checks event payloads', () => {
      const payload: CronPayload = {
        kind: 'event',
        eventName: 'CUSTOM_EVENT',
        payload: { data: 123 },
      };
      expect(payload.kind).toBe('event');
    });
  });

  describe('CronJob structure', () => {
    it('has all required fields', () => {
      const job: CronJob = {
        id: 'test-id',
        name: 'Test Job',
        enabled: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: 'every', everyMs: 60000 },
        payload: { kind: 'prompt', text: 'Test' },
        state: {
          runCount: 0,
          errorCount: 0,
        },
      };

      expect(job.id).toBeDefined();
      expect(job.name).toBeDefined();
      expect(job.schedule).toBeDefined();
      expect(job.payload).toBeDefined();
      expect(job.state).toBeDefined();
    });

    it('accepts optional fields', () => {
      const job: CronJob = {
        id: 'test-id',
        name: 'Test Job',
        description: 'A test job',
        enabled: true,
        deleteAfterRun: true,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: { kind: 'at', at: '2024-12-31T23:59:59Z' },
        payload: { kind: 'prompt', text: 'Test' },
        state: {
          nextRunAtMs: Date.now() + 60000,
          lastRunAtMs: Date.now() - 60000,
          lastStatus: 'ok',
          lastDurationMs: 100,
          runCount: 5,
          errorCount: 0,
        },
        tags: ['test', 'example'],
        metadata: { custom: 'data' },
      };

      expect(job.description).toBe('A test job');
      expect(job.deleteAfterRun).toBe(true);
      expect(job.tags).toContain('test');
      expect(job.metadata?.custom).toBe('data');
    });
  });

  describe('CronJobCreate type', () => {
    it('omits id, timestamps, and state', () => {
      const input: CronJobCreate = {
        name: 'New Job',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        payload: { kind: 'prompt', text: 'Test' },
      };

      expect(input.name).toBe('New Job');
      expect("id" in input).toBe(false);
    });

    it('accepts partial state', () => {
      const input: CronJobCreate = {
        name: 'New Job',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        payload: { kind: 'prompt', text: 'Test' },
        state: {
          runCount: 10, // For migration purposes
        },
      };

      expect(input.state?.runCount).toBe(10);
    });
  });

  describe('CronJobPatch type', () => {
    it('allows partial updates', () => {
      const patch: CronJobPatch = {
        enabled: false,
      };

      expect(patch.enabled).toBe(false);
      expect(patch.name).toBeUndefined();
    });

    it('allows updating schedule', () => {
      const patch: CronJobPatch = {
        schedule: { kind: 'cron', expr: '0 10 * * *' },
      };

      expect(patch.schedule?.kind).toBe('cron');
    });

    it('allows partial state updates', () => {
      const patch: CronJobPatch = {
        state: {
          lastError: undefined, // Clear error
        },
      };

      expect(patch.state?.lastError).toBeUndefined();
    });
  });
});
