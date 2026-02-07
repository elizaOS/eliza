/**
 * @module timer-manager-extended.test
 * @description Extended tests for timer manager - concurrent behavior, edge cases
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { TimerManager, type JobDueCallback } from '../scheduler/timer-manager.js';
import type { CronJob, CronServiceConfig } from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';

function createMockJob(overrides: Partial<CronJob> = {}): CronJob {
  const nowMs = Date.now();
  return {
    id: `test-job-${Math.random().toString(36).slice(2)}`,
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

describe('TimerManager extended', () => {
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

  // ==========================================================================
  // CONCURRENT JOB HANDLING
  // ==========================================================================

  describe('concurrent job handling', () => {
    it('fires multiple jobs that are due at the same time', async () => {
      const nowMs = Date.now();
      const dueTime = nowMs + 100;

      const job1 = createMockJob({
        id: 'job-1',
        state: { nextRunAtMs: dueTime, runCount: 0, errorCount: 0 },
      });
      const job2 = createMockJob({
        id: 'job-2',
        state: { nextRunAtMs: dueTime, runCount: 0, errorCount: 0 },
      });
      const job3 = createMockJob({
        id: 'job-3',
        state: { nextRunAtMs: dueTime, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job1);
      timerManager.trackJob(job2);
      timerManager.trackJob(job3);
      timerManager.start();

      // Advance past due time
      await vi.advanceTimersByTimeAsync(200);

      // All three jobs should have fired
      expect(onJobDueMock).toHaveBeenCalledTimes(3);
      expect(onJobDueMock).toHaveBeenCalledWith('job-1');
      expect(onJobDueMock).toHaveBeenCalledWith('job-2');
      expect(onJobDueMock).toHaveBeenCalledWith('job-3');
    });

    it('does not fire the same job twice while marked as executing', async () => {
      const nowMs = Date.now();
      const job = createMockJob({
        id: 'single-job',
        state: { nextRunAtMs: nowMs - 1000, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job);
      timerManager.start();

      // First check should fire the job
      await vi.advanceTimersByTimeAsync(100);
      expect(onJobDueMock).toHaveBeenCalledTimes(1);
      expect(onJobDueMock).toHaveBeenCalledWith('single-job');

      // Mark executing to prevent double-fire
      timerManager.markExecuting('single-job');

      // Additional checks should not fire while executing
      await vi.advanceTimersByTimeAsync(200);
      expect(onJobDueMock).toHaveBeenCalledTimes(1); // Still 1
    });

    it('handles jobs with staggered due times', async () => {
      const nowMs = Date.now();
      // Use larger intervals to avoid tolerance window overlaps
      // Default tolerance is 1000ms, so use intervals > 2x tolerance

      const job1 = createMockJob({
        id: 'job-1',
        state: { nextRunAtMs: nowMs + 100, runCount: 0, errorCount: 0 },
      });
      const job2 = createMockJob({
        id: 'job-2',
        state: { nextRunAtMs: nowMs + 3000, runCount: 0, errorCount: 0 },
      });
      const job3 = createMockJob({
        id: 'job-3',
        state: { nextRunAtMs: nowMs + 6000, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job1);
      timerManager.trackJob(job2);
      timerManager.trackJob(job3);
      timerManager.start();

      // After 200ms, only job1 should fire (due at 100ms)
      await vi.advanceTimersByTimeAsync(200);
      expect(onJobDueMock).toHaveBeenCalledWith('job-1');
      expect(onJobDueMock).toHaveBeenCalledTimes(1);

      // After 3500ms total, job2 should fire (due at 3000ms)
      await vi.advanceTimersByTimeAsync(3300);
      expect(onJobDueMock).toHaveBeenCalledWith('job-2');
      expect(onJobDueMock).toHaveBeenCalledTimes(2);

      // After 6500ms total, job3 should fire (due at 6000ms)
      await vi.advanceTimersByTimeAsync(3000);
      expect(onJobDueMock).toHaveBeenCalledWith('job-3');
      expect(onJobDueMock).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // CALLBACK ERROR HANDLING
  // ==========================================================================

  describe('callback error handling', () => {
    it('continues processing other jobs when callback throws', async () => {
      const nowMs = Date.now();
      const dueTime = nowMs - 1000;

      // Make job-1 callback throw
      onJobDueMock.mockImplementation(async (jobId: string) => {
        if (jobId === 'job-1') {
          throw new Error('Callback failed');
        }
      });

      const job1 = createMockJob({
        id: 'job-1',
        state: { nextRunAtMs: dueTime, runCount: 0, errorCount: 0 },
      });
      const job2 = createMockJob({
        id: 'job-2',
        state: { nextRunAtMs: dueTime, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job1);
      timerManager.trackJob(job2);
      timerManager.start();

      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await vi.advanceTimersByTimeAsync(200);

      // Both jobs should have been called despite error
      expect(onJobDueMock).toHaveBeenCalledWith('job-1');
      expect(onJobDueMock).toHaveBeenCalledWith('job-2');

      consoleSpy.mockRestore();
    });

    it('logs error when callback throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      onJobDueMock.mockRejectedValue(new Error('Test error'));

      const nowMs = Date.now();
      const job = createMockJob({
        state: { nextRunAtMs: nowMs - 1000, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job);
      timerManager.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Error executing job');

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('edge cases', () => {
    it('handles stopping while jobs are executing', async () => {
      const nowMs = Date.now();

      // Make callback hang
      onJobDueMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10000))
      );

      const job = createMockJob({
        state: { nextRunAtMs: nowMs - 1000, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job);
      timerManager.start();

      // Trigger the job
      await vi.advanceTimersByTimeAsync(100);
      expect(onJobDueMock).toHaveBeenCalled();

      // Stop while job is still "executing"
      timerManager.stop();

      // Should not throw
      expect(timerManager.getTrackedJobCount()).toBe(0);
    });

    it('handles rapid track/untrack cycles', () => {
      const job = createMockJob();

      // Rapid cycles should not cause issues
      for (let i = 0; i < 100; i++) {
        timerManager.trackJob(job);
        timerManager.untrackJob(job.id);
      }

      expect(timerManager.getTrackedJobCount()).toBe(0);
    });

    it('handles job state with undefined nextRunAtMs', async () => {
      const job = createMockJob({
        state: { nextRunAtMs: undefined, runCount: 0, errorCount: 0 },
        schedule: { kind: 'every', everyMs: 60000 },
      });

      timerManager.trackJob(job);
      timerManager.start();

      await vi.advanceTimersByTimeAsync(200);

      // Job should still be tracked and have calculated a nextRunAtMs
      expect(timerManager.getTrackedJobIds()).toContain(job.id);
    });

    it('handles markExecuting on non-existent job', () => {
      // Should not throw
      expect(() => timerManager.markExecuting('non-existent')).not.toThrow();
    });

    it('handles markFinished on non-existent job', () => {
      // Should not throw
      expect(() => timerManager.markFinished('non-existent')).not.toThrow();
    });

    it('handles cron schedule jobs correctly', () => {
      const job = createMockJob({
        schedule: { kind: 'cron', expr: '* * * * *' },
        state: { runCount: 0, errorCount: 0 },
      });

      // Should track without error
      expect(() => timerManager.trackJob(job)).not.toThrow();
      expect(timerManager.getTrackedJobCount()).toBe(1);
    });

    it('handles at schedule jobs correctly', () => {
      const futureMs = Date.now() + 60000;
      const job = createMockJob({
        schedule: { kind: 'at', at: new Date(futureMs).toISOString() },
        state: { nextRunAtMs: futureMs, runCount: 0, errorCount: 0 },
      });

      expect(() => timerManager.trackJob(job)).not.toThrow();
      expect(timerManager.getTrackedJobCount()).toBe(1);
    });
  });

  // ==========================================================================
  // STATE MANAGEMENT
  // ==========================================================================

  describe('state management', () => {
    it('correctly reports executing state', () => {
      const job = createMockJob();
      timerManager.trackJob(job);

      expect(timerManager.isJobExecuting(job.id)).toBe(false);

      timerManager.markExecuting(job.id);
      expect(timerManager.isJobExecuting(job.id)).toBe(true);

      timerManager.markFinished(job.id);
      expect(timerManager.isJobExecuting(job.id)).toBe(false);
    });

    it('updates job data when markFinished is called with updated job', () => {
      const nowMs = Date.now();
      const job = createMockJob({
        state: { nextRunAtMs: nowMs, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job);
      timerManager.markExecuting(job.id);

      const updatedJob = {
        ...job,
        state: { ...job.state, nextRunAtMs: nowMs + 120000, runCount: 1 },
      };

      timerManager.markFinished(job.id, updatedJob);

      // The next run time should be updated
      expect(timerManager.getNextRunAtMs(job.id)).toBeDefined();
    });

    it('returns correct tracked job IDs', () => {
      const job1 = createMockJob({ id: 'alpha' });
      const job2 = createMockJob({ id: 'beta' });
      const job3 = createMockJob({ id: 'gamma' });

      timerManager.trackJob(job1);
      timerManager.trackJob(job2);
      timerManager.trackJob(job3);

      const ids = timerManager.getTrackedJobIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('alpha');
      expect(ids).toContain('beta');
      expect(ids).toContain('gamma');
    });
  });

  // ==========================================================================
  // TOLERANCE AND TIMING
  // ==========================================================================

  describe('tolerance and timing', () => {
    it('fires job within default tolerance window', async () => {
      const nowMs = Date.now();
      // Job scheduled 500ms in future, but tolerance is 1000ms
      const job = createMockJob({
        state: { nextRunAtMs: nowMs + 500, runCount: 0, errorCount: 0 },
      });

      timerManager.trackJob(job);
      timerManager.start();

      // Without advancing time much, the job should fire due to tolerance
      await vi.advanceTimersByTimeAsync(100);

      expect(onJobDueMock).toHaveBeenCalledWith(job.id);
    });

    it('respects check interval timing', async () => {
      const checkCount = vi.fn();
      
      // Create a manager with longer check interval
      const slowConfig = { ...config, timerCheckIntervalMs: 500 };
      const slowManager = new TimerManager(slowConfig, async () => {
        checkCount();
      });

      const nowMs = Date.now();
      const job = createMockJob({
        state: { nextRunAtMs: nowMs - 1000, runCount: 0, errorCount: 0 },
      });

      slowManager.trackJob(job);
      slowManager.start();

      // After 400ms, should not have checked yet (interval is 500ms)
      await vi.advanceTimersByTimeAsync(400);
      expect(checkCount).toHaveBeenCalledTimes(0);

      // After 600ms total, should have checked once
      await vi.advanceTimersByTimeAsync(200);
      expect(checkCount).toHaveBeenCalledTimes(1);

      slowManager.stop();
    });
  });
});
