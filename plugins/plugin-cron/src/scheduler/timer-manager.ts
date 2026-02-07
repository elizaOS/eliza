/**
 * @module timer-manager
 * @description Manages timers for cron job scheduling
 *
 * Uses a periodic check interval that:
 * 1. Identifies jobs that are due
 * 2. Fires callbacks for due jobs
 * 3. Recalculates next run times
 *
 * Croner is used for parsing cron expressions, but timing is managed
 * internally via setInterval for consistent behavior across schedule types.
 */

import { Cron } from 'croner';
import type { CronJob, CronServiceConfig } from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';
import { computeNextRunAtMs, isJobDue } from './schedule-utils.js';

/**
 * Callback invoked when a job is due for execution
 */
export type JobDueCallback = (jobId: string) => Promise<void>;

/**
 * Internal state for a tracked job
 */
interface TrackedJob {
  job: CronJob;
  /** Croner instance for cron-type schedules */
  cronInstance?: Cron;
  /** Next calculated run time */
  nextRunAtMs?: number;
  /** Whether this job is currently being executed */
  executing: boolean;
}

/**
 * Timer manager for cron job scheduling
 */
export class TimerManager {
  private readonly config: CronServiceConfig;
  private readonly onJobDue: JobDueCallback;
  private readonly trackedJobs: Map<string, TrackedJob> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private running: boolean = false;

  constructor(config: CronServiceConfig, onJobDue: JobDueCallback) {
    this.config = config;
    this.onJobDue = onJobDue;
  }

  /**
   * Starts the timer manager
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.startCheckInterval();
  }

  /**
   * Stops the timer manager and cleans up all timers
   */
  stop(): void {
    this.running = false;
    this.stopCheckInterval();
    this.clearAllJobs();
  }

  /**
   * Adds or updates a job in the timer manager
   * @param job The job to track
   */
  trackJob(job: CronJob): void {
    // Remove existing tracking if present
    this.untrackJob(job.id);

    // Don't track disabled jobs
    if (!job.enabled) {
      return;
    }

    const tracked: TrackedJob = {
      job,
      executing: false,
    };

    // For cron schedules, create a croner instance
    if (job.schedule.kind === 'cron') {
      const cronInstance = new Cron(job.schedule.expr, {
        timezone: job.schedule.tz?.trim() || undefined,
        catch: true,
        paused: true, // We manage firing manually via the check interval
      });
      tracked.cronInstance = cronInstance;
    }

    // Use persisted next run time if available, otherwise calculate from schedule
    // This is important for jobs loaded from storage that may already be due
    tracked.nextRunAtMs =
      job.state.nextRunAtMs ?? computeNextRunAtMs(job.schedule, Date.now());

    this.trackedJobs.set(job.id, tracked);
  }

  /**
   * Removes a job from tracking
   * @param jobId The job ID to remove
   */
  untrackJob(jobId: string): void {
    const tracked = this.trackedJobs.get(jobId);
    if (tracked) {
      // Stop and cleanup croner instance
      if (tracked.cronInstance) {
        tracked.cronInstance.stop();
      }
      this.trackedJobs.delete(jobId);
    }
  }

  /**
   * Marks a job as currently executing (to prevent overlapping executions)
   * @param jobId The job ID
   */
  markExecuting(jobId: string): void {
    const tracked = this.trackedJobs.get(jobId);
    if (tracked) {
      tracked.executing = true;
    }
  }

  /**
   * Marks a job as finished executing and recalculates next run
   * @param jobId The job ID
   * @param updatedJob The job with updated state (optional)
   */
  markFinished(jobId: string, updatedJob?: CronJob): void {
    const tracked = this.trackedJobs.get(jobId);
    if (tracked) {
      tracked.executing = false;

      if (updatedJob) {
        tracked.job = updatedJob;
        tracked.nextRunAtMs = computeNextRunAtMs(updatedJob.schedule, Date.now());
      }
    }
  }

  /**
   * Gets the next scheduled run time for a job
   * @param jobId The job ID
   * @returns Next run time in ms, or undefined
   */
  getNextRunAtMs(jobId: string): number | undefined {
    return this.trackedJobs.get(jobId)?.nextRunAtMs;
  }

  /**
   * Gets all tracked job IDs
   */
  getTrackedJobIds(): string[] {
    return Array.from(this.trackedJobs.keys());
  }

  /**
   * Gets the count of tracked jobs
   */
  getTrackedJobCount(): number {
    return this.trackedJobs.size;
  }

  /**
   * Checks if a specific job is currently executing
   */
  isJobExecuting(jobId: string): boolean {
    return this.trackedJobs.get(jobId)?.executing ?? false;
  }

  /**
   * Forces an immediate check for due jobs
   */
  checkNow(): void {
    if (this.running) {
      this.performCheck();
    }
  }

  /**
   * Starts the periodic check interval
   */
  private startCheckInterval(): void {
    if (this.checkInterval) {
      return;
    }

    const intervalMs = this.config.timerCheckIntervalMs ?? DEFAULT_CRON_CONFIG.timerCheckIntervalMs;
    this.checkInterval = setInterval(() => {
      this.performCheck();
    }, intervalMs);

    // Unref so the interval doesn't prevent process exit
    if (this.checkInterval.unref) {
      this.checkInterval.unref();
    }
  }

  /**
   * Stops the periodic check interval
   */
  private stopCheckInterval(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Performs a check for all due jobs
   */
  private performCheck(): void {
    const nowMs = Date.now();
    const dueJobs: string[] = [];

    for (const [jobId, tracked] of this.trackedJobs) {
      // Skip jobs that are currently executing
      if (tracked.executing) {
        continue;
      }

      // Skip disabled jobs
      if (!tracked.job.enabled) {
        continue;
      }

      // Check if the job is due
      if (isJobDue(tracked.nextRunAtMs, nowMs)) {
        dueJobs.push(jobId);
      }
    }

    // Fire callbacks for due jobs
    // We do this in a separate loop to avoid modifying the map while iterating
    for (const jobId of dueJobs) {
      const tracked = this.trackedJobs.get(jobId);
      if (tracked && !tracked.executing) {
        tracked.executing = true;

        // Fire the callback asynchronously
        // The callback is responsible for calling markFinished when done
        this.onJobDue(jobId).catch((error) => {
          // Log error but don't crash - the job will be marked as finished
          // by the service even on error
          console.error(`[CronTimerManager] Error executing job ${jobId}:`, error);
        });
      }
    }
  }

  /**
   * Clears all tracked jobs
   */
  private clearAllJobs(): void {
    for (const [, tracked] of this.trackedJobs) {
      if (tracked.cronInstance) {
        tracked.cronInstance.stop();
      }
    }
    this.trackedJobs.clear();
  }
}
