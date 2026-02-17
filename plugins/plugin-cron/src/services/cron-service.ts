/**
 * @module cron-service
 * @description Main service for cron job management
 *
 * The CronService handles:
 * - Job CRUD operations
 * - Timer management for scheduling
 * - Job execution coordination
 * - Event emission for job lifecycle
 * - Persistence via component storage
 */

import { Service, logger, type IAgentRuntime } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronJobFilter,
  CronJobState,
  CronServiceConfig,
  CronExecutionResult,
  CronEventData,
} from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';
import { CRON_SERVICE_TYPE, CronEvents } from '../constants.js';
import { getCronStorage, type CronStorage } from '../storage/cron-storage.js';
import { TimerManager } from '../scheduler/timer-manager.js';
import {
  computeNextRunAtMs,
  validateSchedule,
  formatSchedule,
} from '../scheduler/schedule-utils.js';
import { executeJob, validateJobExecutability } from '../executor/job-executor.js';
import { startHeartbeat } from '../heartbeat/worker.js';

/**
 * Cron scheduling service for elizaOS
 *
 * Provides the ability to schedule recurring or one-time jobs that
 * execute prompts, actions, or emit events on a defined schedule.
 */
export class CronService extends Service {
  static serviceType = CRON_SERVICE_TYPE;
  capabilityDescription = 'Schedules and executes recurring or one-time cron jobs';

  private cronConfig: CronServiceConfig;
  private storage!: CronStorage;
  private timerManager!: TimerManager;
  private initialized: boolean = false;

  constructor(runtime?: IAgentRuntime, config?: Partial<CronServiceConfig>) {
    super(runtime);
    this.cronConfig = { ...DEFAULT_CRON_CONFIG, ...config };
  }

  /**
   * Starts the cron service
   */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CronService(runtime);
    await service.initialize();
    return service;
  }

  /**
   * Initializes the service, loading existing jobs and starting timers
   */
  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize storage
    this.storage = getCronStorage(this.runtime);

    // Initialize timer manager
    this.timerManager = new TimerManager(this.cronConfig, async (jobId) => {
      await this.handleJobDue(jobId);
    });

    // Load existing jobs and track them
    const jobs = await this.storage.listJobs({ includeDisabled: true });
    for (const job of jobs) {
      // Recalculate next run time in case we missed runs while stopped
      const nowMs = Date.now();
      const nextRunAtMs = computeNextRunAtMs(job.schedule, nowMs);

      // Update state if needed
      if (job.state.nextRunAtMs !== nextRunAtMs) {
        job.state.nextRunAtMs = nextRunAtMs;
        await this.storage.saveJob(job);
      }

      // Track enabled jobs
      if (job.enabled) {
        this.timerManager.trackJob(job);
      }
    }

    // Handle catch-up for missed jobs if configured
    if (this.cronConfig.catchUpMissedJobs) {
      await this.handleMissedJobs(jobs);
    }

    // Start the timer manager
    this.timerManager.start();

    // Start heartbeat worker (registers TaskWorker + creates recurring task)
    await startHeartbeat(this.runtime);

    this.initialized = true;
    logger.info(
      `[CronService] Started for agent ${this.runtime.agentId} with ${jobs.length} jobs`
    );
  }

  /**
   * Stops the cron service
   */
  async stop(): Promise<void> {
    if (this.timerManager) {
      this.timerManager.stop();
    }
    this.initialized = false;
    logger.info(`[CronService] Stopped for agent ${this.runtime.agentId}`);
  }

  /**
   * Gets the service configuration
   */
  getConfig(): CronServiceConfig {
    return { ...this.cronConfig };
  }

  // ============================================================================
  // CRUD OPERATIONS
  // ============================================================================

  /**
   * Creates a new cron job
   * @param input Job creation input
   * @returns The created job
   * @throws Error if validation fails or max jobs exceeded
   */
  async createJob(input: CronJobCreate): Promise<CronJob> {
    // Validate schedule
    const scheduleError = validateSchedule(input.schedule, this.cronConfig);
    if (scheduleError) {
      throw new Error(`Invalid schedule: ${scheduleError}`);
    }

    // Check job limit
    const currentCount = await this.storage.getJobCount();
    if (currentCount >= this.cronConfig.maxJobsPerAgent) {
      throw new Error(
        `Maximum jobs limit reached (${this.cronConfig.maxJobsPerAgent}). Delete some jobs before creating new ones.`
      );
    }

    // Validate executability
    const nowMs = Date.now();
    const job: CronJob = {
      id: uuidv4(),
      name: input.name,
      description: input.description,
      // Explicitly default to true if not provided - jobs are enabled by default
      enabled: input.enabled ?? true,
      // Explicitly default to false - jobs persist after run by default
      deleteAfterRun: input.deleteAfterRun ?? false,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: input.schedule,
      payload: input.payload,
      tags: input.tags,
      metadata: input.metadata,
      state: {
        nextRunAtMs: computeNextRunAtMs(input.schedule, nowMs),
        runCount: input.state?.runCount ?? 0,
        errorCount: input.state?.errorCount ?? 0,
        ...input.state,
      },
    };

    // Validate the job can be executed
    const execError = validateJobExecutability(this.runtime, job);
    if (execError) {
      throw new Error(`Job cannot be executed: ${execError}`);
    }

    // Save to storage
    await this.storage.saveJob(job);

    // Track in timer manager if enabled
    if (job.enabled) {
      this.timerManager.trackJob(job);
    }

    // Emit creation event
    await this.emitCronEvent(CronEvents.CRON_CREATED, job);

    logger.info(
      `[CronService] Created job "${job.name}" (${job.id}) - ${formatSchedule(job.schedule)}`
    );

    return job;
  }

  /**
   * Updates an existing cron job
   * @param jobId The job ID to update
   * @param patch The fields to update
   * @returns The updated job
   * @throws Error if job not found or validation fails
   */
  async updateJob(jobId: string, patch: CronJobPatch): Promise<CronJob> {
    const existing = await this.storage.getJob(jobId);
    if (!existing) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // If schedule is being updated, validate it
    if (patch.schedule) {
      const scheduleError = validateSchedule(patch.schedule, this.cronConfig);
      if (scheduleError) {
        throw new Error(`Invalid schedule: ${scheduleError}`);
      }
    }

    const nowMs = Date.now();

    // Apply patch
    const updated: CronJob = {
      ...existing,
      ...patch,
      id: existing.id, // Ensure ID is immutable
      createdAtMs: existing.createdAtMs, // Ensure createdAt is immutable
      updatedAtMs: nowMs,
      state: {
        ...existing.state,
        ...patch.state,
      },
    };

    // Recalculate next run time if schedule changed or job was enabled
    if (patch.schedule || (patch.enabled === true && !existing.enabled)) {
      updated.state.nextRunAtMs = computeNextRunAtMs(updated.schedule, nowMs);
    }

    // Clear next run if disabled
    if (patch.enabled === false) {
      updated.state.nextRunAtMs = undefined;
      updated.state.runningAtMs = undefined;
    }

    // Validate executability if payload changed
    if (patch.payload) {
      const execError = validateJobExecutability(this.runtime, updated);
      if (execError) {
        throw new Error(`Job cannot be executed: ${execError}`);
      }
    }

    // Save to storage
    await this.storage.saveJob(updated);

    // Update timer tracking
    if (updated.enabled) {
      this.timerManager.trackJob(updated);
    } else {
      this.timerManager.untrackJob(jobId);
    }

    // Emit update event
    await this.emitCronEvent(CronEvents.CRON_UPDATED, updated);

    logger.info(`[CronService] Updated job "${updated.name}" (${updated.id})`);

    return updated;
  }

  /**
   * Deletes a cron job
   * @param jobId The job ID to delete
   * @returns true if deleted, false if not found
   */
  async deleteJob(jobId: string): Promise<boolean> {
    const existing = await this.storage.getJob(jobId);
    if (!existing) {
      return false;
    }

    // Remove from timer tracking
    this.timerManager.untrackJob(jobId);

    // Delete from storage
    const deleted = await this.storage.deleteJob(jobId);

    if (deleted) {
      // Emit deletion event
      await this.emitCronEvent(CronEvents.CRON_DELETED, existing);
      logger.info(`[CronService] Deleted job "${existing.name}" (${existing.id})`);
    }

    return deleted;
  }

  /**
   * Gets a job by ID
   * @param jobId The job ID
   * @returns The job or null if not found
   */
  async getJob(jobId: string): Promise<CronJob | null> {
    return this.storage.getJob(jobId);
  }

  /**
   * Lists all jobs, optionally filtered
   * @param filter Optional filter criteria
   * @returns Array of matching jobs
   */
  async listJobs(filter?: CronJobFilter): Promise<CronJob[]> {
    return this.storage.listJobs(filter);
  }

  /**
   * Gets the count of jobs
   */
  async getJobCount(): Promise<number> {
    return this.storage.getJobCount();
  }

  // ============================================================================
  // EXECUTION
  // ============================================================================

  /**
   * Manually runs a job immediately
   * @param jobId The job ID to run
   * @param mode 'force' to run even if disabled, 'due' to only run if due
   * @returns Execution result
   */
  async runJob(
    jobId: string,
    mode: 'force' | 'due' = 'force'
  ): Promise<CronExecutionResult & { ran: boolean }> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Check if we should run based on mode
    if (mode === 'due') {
      const nowMs = Date.now();
      const nextRunAtMs = job.state.nextRunAtMs;
      if (!nextRunAtMs || nowMs < nextRunAtMs) {
        return {
          ran: false,
          status: 'skipped',
          durationMs: 0,
          error: 'Job is not due yet',
        };
      }
    }

    // Check if job is disabled and mode is not force
    if (!job.enabled && mode !== 'force') {
      return {
        ran: false,
        status: 'skipped',
        durationMs: 0,
        error: 'Job is disabled',
      };
    }

    // Execute the job
    const result = await this.executeJobInternal(job);

    return {
      ran: true,
      ...result,
    };
  }

  // ============================================================================
  // INTERNAL METHODS
  // ============================================================================

  /**
   * Handles a job becoming due (called by timer manager)
   */
  private async handleJobDue(jobId: string): Promise<void> {
    const job = await this.storage.getJob(jobId);
    if (!job) {
      // Job was deleted while timer was pending
      this.timerManager.untrackJob(jobId);
      return;
    }

    if (!job.enabled) {
      // Job was disabled while timer was pending
      this.timerManager.untrackJob(jobId);
      return;
    }

    await this.executeJobInternal(job);
  }

  /**
   * Internal job execution with state management
   */
  private async executeJobInternal(job: CronJob): Promise<CronExecutionResult> {
    const nowMs = Date.now();

    // Update state to running
    job.state.runningAtMs = nowMs;
    await this.storage.saveJob(job);

    logger.debug(`[CronService] Executing job "${job.name}" (${job.id})`);

    // Execute the job
    const result = await executeJob(this.runtime, job, this.cronConfig);

    // Update state after execution
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = nowMs;
    job.state.lastStatus = result.status;
    job.state.lastDurationMs = result.durationMs;

    if (result.status === 'ok') {
      job.state.runCount += 1;
      job.state.lastError = undefined;
    } else {
      job.state.errorCount += 1;
      job.state.lastError = result.error;
    }

    // Calculate next run time
    const nextNowMs = Date.now();
    job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, nextNowMs);
    job.updatedAtMs = nextNowMs;

    // Check if this is a one-shot job that should be deleted
    if (job.deleteAfterRun && result.status === 'ok') {
      await this.storage.deleteJob(job.id);
      this.timerManager.untrackJob(job.id);
      logger.info(
        `[CronService] Deleted one-shot job "${job.name}" (${job.id}) after successful execution`
      );
    } else {
      // Save updated state
      await this.storage.saveJob(job);

      // Update timer tracking with new state
      this.timerManager.markFinished(job.id, job);
    }

    // Emit appropriate event
    const eventName = result.status === 'ok' ? CronEvents.CRON_FIRED : CronEvents.CRON_FAILED;
    await this.emitCronEvent(eventName, job, result);

    logger.info(
      `[CronService] Job "${job.name}" (${job.id}) completed with status: ${result.status}` +
        (result.error ? ` - ${result.error}` : '')
    );

    return result;
  }

  /**
   * Handles catch-up for jobs that may have been missed while the service was stopped
   */
  private async handleMissedJobs(jobs: CronJob[]): Promise<void> {
    const nowMs = Date.now();
    const windowStart = nowMs - this.cronConfig.catchUpWindowMs;

    for (const job of jobs) {
      if (!job.enabled) {
        continue;
      }

      // Check if the job was due within the catch-up window
      const lastRunAtMs = job.state.lastRunAtMs ?? 0;
      const nextRunAtMs = job.state.nextRunAtMs;

      if (
        nextRunAtMs &&
        nextRunAtMs >= windowStart &&
        nextRunAtMs < nowMs &&
        lastRunAtMs < nextRunAtMs
      ) {
        logger.info(
          `[CronService] Catching up missed job "${job.name}" (${job.id}) that was due at ${new Date(nextRunAtMs).toISOString()}`
        );

        await this.executeJobInternal(job);
      }
    }
  }

  /**
   * Emits a cron event
   */
  private async emitCronEvent(
    eventName: string,
    job: CronJob,
    result?: CronExecutionResult
  ): Promise<void> {
    const eventData: CronEventData = {
      jobId: job.id,
      jobName: job.name,
      schedule: job.schedule,
    };

    if (result) {
      eventData.result = {
        status: result.status,
        durationMs: result.durationMs,
        output: result.output,
        error: result.error,
      };
    }

    await this.runtime.emitEvent(eventName, {
      runtime: this.runtime,
      source: `cron:${job.id}`,
      ...eventData,
    });
  }

  // ============================================================================
  // STATUS AND DIAGNOSTICS
  // ============================================================================

  /**
   * Gets the service status
   */
  async getStatus(): Promise<{
    initialized: boolean;
    jobCount: number;
    trackedJobCount: number;
    config: CronServiceConfig;
  }> {
    return {
      initialized: this.initialized,
      jobCount: await this.storage.getJobCount(),
      trackedJobCount: this.timerManager?.getTrackedJobCount() ?? 0,
      config: this.cronConfig,
    };
  }

  /**
   * Performs a health check
   */
  async healthCheck(): Promise<{ healthy: boolean; issues: string[] }> {
    const issues: string[] = [];

    if (!this.initialized) {
      issues.push('Service not initialized');
    }

    if (!this.storage) {
      issues.push('Storage not available');
    }

    if (!this.timerManager) {
      issues.push('Timer manager not available');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}
