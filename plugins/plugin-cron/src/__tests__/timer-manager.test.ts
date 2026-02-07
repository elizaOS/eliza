/**
 * @module timer-manager.test
 * @description Tests for the timer manager
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { TimerManager, type JobDueCallback } from '../scheduler/timer-manager.js';
import type { CronJob, CronServiceConfig } from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';

// Helper to create a mock job
function createMockJob(overrides: Partial<CronJob> = {}): CronJob {
  const nowMs = Date.now();
  return {
    id: 'test-job-1',
    name: 'Test Job',
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: 'every', everyMs: 60000, anchorMs: nowMs },
    payload: { kind: 'prompt', text: 'Test prompt' },
    state: {
      nextRunAtMs: nowMs + 60000,
      runCount: 0,
      errorCount: 0,
    },
    ...overrides,
  };
}

describe('TimerManager', () => {
  let timerManager: TimerManager;
  let onJobDueMock: Mock<JobDueCallback>;
  let config: CronServiceConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    onJobDueMock = vi.fn<JobDueCallback>().mockResolvedValue(undefined);
    config = { ...DEFAULT_CRON_CONFIG, timerCheckIntervalMs: 100 };
    timerManager = new TimerManager(config, onJobDueMock);
  });

  afterEach(() => {
    timerManager.stop();
    vi.useRealTimers();
  });

  describe('start/stop', () => {
    it('starts and stops without errors', () => {
      expect(() => timerManager.start()).not.toThrow();
      expect(() => timerManager.stop()).not.toThrow();
    });

    it('can be started multiple times safely', () => {
      timerManager.start();
      timerManager.start();
      timerManager.start();
      expect(timerManager.getTrackedJobCount()).toBe(0);
    });
  });

  describe('trackJob', () => {
    it('tracks enabled jobs', () => {
      const job = createMockJob();
      timerManager.trackJob(job);
      expect(timerManager.getTrackedJobCount()).toBe(1);
      expect(timerManager.getTrackedJobIds()).toContain(job.id);
    });

    it('does not track disabled jobs', () => {
      const job = createMockJob({ enabled: false });
      timerManager.trackJob(job);
      expect(timerManager.getTrackedJobCount()).toBe(0);
    });

    it('replaces existing job tracking', () => {
      const job1 = createMockJob({ name: 'Original' });
      const job2 = createMockJob({ name: 'Updated' });

      timerManager.trackJob(job1);
      timerManager.trackJob(job2);

      expect(timerManager.getTrackedJobCount()).toBe(1);
    });
  });

  describe('untrackJob', () => {
    it('removes tracked jobs', () => {
      const job = createMockJob();
      timerManager.trackJob(job);
      expect(timerManager.getTrackedJobCount()).toBe(1);

      timerManager.untrackJob(job.id);
      expect(timerManager.getTrackedJobCount()).toBe(0);
    });

    it('handles untracking non-existent jobs gracefully', () => {
      expect(() => timerManager.untrackJob('non-existent')).not.toThrow();
    });
  });

  describe('job execution', () => {
    it('fires callback when job is due', async () => {
      const nowMs = Date.now();
      const job = createMockJob({
        schedule: { kind: 'every', everyMs: 100, anchorMs: nowMs },
        state: {
          nextRunAtMs: nowMs + 100,
          runCount: 0,
          errorCount: 0,
        },
      });

      timerManager.trackJob(job);
      timerManager.start();

      // Advance time past the scheduled run and trigger a check interval
      await vi.advanceTimersByTimeAsync(200);

      expect(onJobDueMock).toHaveBeenCalledWith(job.id);
    });

    it('does not fire callback for disabled jobs', async () => {
      const nowMs = Date.now();
      const job = createMockJob({
        enabled: false,
        state: {
          nextRunAtMs: nowMs - 1000, // Past due
          runCount: 0,
          errorCount: 0,
        },
      });

      // Disabled jobs should not be tracked
      timerManager.trackJob(job);
      timerManager.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(onJobDueMock).not.toHaveBeenCalled();
    });

    it('does not fire callback for jobs not yet due', async () => {
      const nowMs = Date.now();
      const job = createMockJob({
        state: {
          nextRunAtMs: nowMs + 100000, // Far in future
          runCount: 0,
          errorCount: 0,
        },
      });

      timerManager.trackJob(job);
      timerManager.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(onJobDueMock).not.toHaveBeenCalled();
    });
  });

  describe('markExecuting/markFinished', () => {
    it('marks jobs as executing', () => {
      const job = createMockJob();
      timerManager.trackJob(job);
      timerManager.markExecuting(job.id);

      expect(timerManager.isJobExecuting(job.id)).toBe(true);
    });

    it('marks jobs as finished', () => {
      const job = createMockJob();
      timerManager.trackJob(job);
      timerManager.markExecuting(job.id);
      timerManager.markFinished(job.id);

      expect(timerManager.isJobExecuting(job.id)).toBe(false);
    });

    it('does not fire callback for executing jobs', async () => {
      const nowMs = Date.now();
      const job = createMockJob({
        state: {
          nextRunAtMs: nowMs - 1000, // Past due
          runCount: 0,
          errorCount: 0,
        },
      });

      timerManager.trackJob(job);
      timerManager.markExecuting(job.id);
      timerManager.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(onJobDueMock).not.toHaveBeenCalled();
    });
  });

  describe('getNextRunAtMs', () => {
    it('returns next run time for tracked jobs', () => {
      const nowMs = Date.now();
      const nextRunAtMs = nowMs + 60000;
      const job = createMockJob({
        state: {
          nextRunAtMs,
          runCount: 0,
          errorCount: 0,
        },
      });

      timerManager.trackJob(job);
      expect(timerManager.getNextRunAtMs(job.id)).toBe(nextRunAtMs);
    });

    it('returns undefined for untracked jobs', () => {
      expect(timerManager.getNextRunAtMs('non-existent')).toBeUndefined();
    });
  });

  describe('checkNow', () => {
    it('triggers immediate check when running', async () => {
      const nowMs = Date.now();
      const job = createMockJob({
        state: {
          nextRunAtMs: nowMs - 1000, // Past due
          runCount: 0,
          errorCount: 0,
        },
      });

      timerManager.trackJob(job);
      timerManager.start();
      timerManager.checkNow();

      // Flush the microtask queue to allow the async callback to complete
      await Promise.resolve();

      expect(onJobDueMock).toHaveBeenCalledWith(job.id);
    });

    it('does nothing when not running', async () => {
      const nowMs = Date.now();
      const job = createMockJob({
        state: {
          nextRunAtMs: nowMs - 1000,
          runCount: 0,
          errorCount: 0,
        },
      });

      timerManager.trackJob(job);
      // Not started
      timerManager.checkNow();

      // Advance a small amount without starting - nothing should happen
      await vi.advanceTimersByTimeAsync(10);

      expect(onJobDueMock).not.toHaveBeenCalled();
    });
  });
});
