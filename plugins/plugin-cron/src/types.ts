/**
 * @module types
 * @description Type definitions for the cron scheduling plugin
 */

import type { UUID } from '@elizaos/core';

// --- Schedule Types ---

/**
 * One-time schedule that runs at a specific timestamp
 */
export interface CronScheduleAt {
  kind: 'at';
  /** ISO 8601 timestamp for one-time execution */
  at: string;
}

/**
 * Interval-based schedule that runs repeatedly at fixed intervals
 */
export interface CronScheduleEvery {
  kind: 'every';
  /** Interval in milliseconds (minimum enforced by config) */
  everyMs: number;
  /** Optional anchor timestamp for interval calculation */
  anchorMs?: number;
}

/**
 * Cron expression-based schedule supporting standard 5-field or 6-field (with seconds) format
 */
export interface CronScheduleCron {
  kind: 'cron';
  /** Cron expression (e.g., "0 9 * * 1-5" for 9am weekdays) */
  expr: string;
  /** IANA timezone (e.g., "America/New_York"). Defaults to UTC if not specified */
  tz?: string;
}

/**
 * Union type for all schedule variants
 */
export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

// --- Payload Types ---

/**
 * Payload that sends a prompt to the agent for processing
 */
export interface CronPayloadPrompt {
  kind: 'prompt';
  /** The prompt text to send to the agent */
  text: string;
  /** Optional model override (provider/model format or alias) */
  model?: string;
  /** Thinking level for reasoning models */
  thinking?: 'none' | 'low' | 'medium' | 'high';
  /** Execution timeout in seconds (overrides default) */
  timeoutSeconds?: number;
}

/**
 * Payload that invokes a specific action by name
 */
export interface CronPayloadAction {
  kind: 'action';
  /** Name of the action to invoke (must be registered with the runtime) */
  actionName: string;
  /** Parameters to pass to the action handler */
  params?: Record<string, unknown>;
  /** Optional room context for action execution */
  roomId?: UUID;
}

/**
 * Payload that emits a custom event
 */
export interface CronPayloadEvent {
  kind: 'event';
  /** Event name to emit */
  eventName: string;
  /** Event payload data */
  payload?: Record<string, unknown>;
}

/**
 * Union type for all payload variants
 */
export type CronPayload = CronPayloadPrompt | CronPayloadAction | CronPayloadEvent;

// --- Job State ---

/**
 * Status of a job execution
 */
export type CronJobStatus = 'ok' | 'error' | 'skipped' | 'timeout';

/**
 * Runtime state of a cron job, tracking execution history and next run
 */
export interface CronJobState {
  /** Next scheduled run time (ms since epoch) */
  nextRunAtMs?: number;
  /** Currently running since (ms since epoch), undefined if not running */
  runningAtMs?: number;
  /** Last completed run time (ms since epoch) */
  lastRunAtMs?: number;
  /** Status of the last run */
  lastStatus?: CronJobStatus;
  /** Error message from the last run if it failed */
  lastError?: string;
  /** Duration of the last run in milliseconds */
  lastDurationMs?: number;
  /** Total number of successful runs */
  runCount: number;
  /** Total number of failed runs */
  errorCount: number;
}

// --- Job Definition ---

/**
 * Complete definition of a cron job
 */
export interface CronJob {
  /** Unique job identifier (UUID v4) */
  id: string;
  /** Human-readable name for the job */
  name: string;
  /** Optional description explaining what the job does */
  description?: string;
  /** Whether the job is active and will be scheduled */
  enabled: boolean;
  /** If true, the job is deleted after successful execution (for one-shot jobs) */
  deleteAfterRun?: boolean;
  /** Timestamp when the job was created (ms since epoch) */
  createdAtMs: number;
  /** Timestamp when the job was last updated (ms since epoch) */
  updatedAtMs: number;
  /** Schedule configuration defining when the job runs */
  schedule: CronSchedule;
  /** Payload configuration defining what the job does */
  payload: CronPayload;
  /** Runtime state tracking execution history */
  state: CronJobState;
  /** Optional tags for filtering and grouping jobs */
  tags?: string[];
  /** Optional metadata for extensibility */
  metadata?: Record<string, unknown>;
}

// --- API Types ---

/**
 * Input for creating a new cron job (id, timestamps, and state are auto-generated)
 */
export type CronJobCreate = Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs' | 'state'> & {
  /** Optional partial state to initialize (e.g., for migration) */
  state?: Partial<CronJobState>;
};

/**
 * Input for updating an existing cron job (id and createdAt are immutable)
 */
export type CronJobPatch = Partial<Omit<CronJob, 'id' | 'createdAtMs' | 'state'>> & {
  /** Optional partial state updates */
  state?: Partial<CronJobState>;
};

/**
 * Filter options for listing cron jobs
 */
export interface CronJobFilter {
  /** If true, include disabled jobs in results */
  includeDisabled?: boolean;
  /** Filter by tags (matches if job has any of these tags) */
  tags?: string[];
  /** Filter by enabled status */
  enabled?: boolean;
}

// --- Service Configuration ---

/**
 * Configuration options for the cron service
 */
export interface CronServiceConfig {
  /** Minimum interval for 'every' schedules in ms (default: 10000) */
  minIntervalMs: number;
  /** Maximum number of jobs per agent (default: 100) */
  maxJobsPerAgent: number;
  /** Default execution timeout in ms (default: 300000 = 5 minutes) */
  defaultTimeoutMs: number;
  /** Whether to run missed jobs on startup (default: false) */
  catchUpMissedJobs: boolean;
  /** How far back to look for missed jobs in ms (default: 3600000 = 1 hour) */
  catchUpWindowMs: number;
  /** Timer check interval for managing job scheduling in ms (default: 1000) */
  timerCheckIntervalMs: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_CRON_CONFIG: CronServiceConfig = {
  minIntervalMs: 10000, // 10 seconds minimum
  maxJobsPerAgent: 100,
  defaultTimeoutMs: 300000, // 5 minutes
  catchUpMissedJobs: false,
  catchUpWindowMs: 3600000, // 1 hour
  timerCheckIntervalMs: 1000, // 1 second
};

// --- Event Types ---

/**
 * Payload for cron-related events
 */
export interface CronEventData {
  /** Job ID */
  jobId: string;
  /** Job name */
  jobName: string;
  /** Job schedule */
  schedule: CronSchedule;
  /** Execution result (only for CRON_FIRED event) */
  result?: {
    status: CronJobStatus;
    durationMs: number;
    output?: string;
    error?: string;
  };
}

// --- Execution Types ---

/**
 * Result of executing a cron job
 */
export interface CronExecutionResult {
  /** Whether execution was successful */
  status: CronJobStatus;
  /** Duration of execution in milliseconds */
  durationMs: number;
  /** Output from the execution (for prompt payloads) */
  output?: string;
  /** Error message if execution failed */
  error?: string;
}

/**
 * Context provided during job execution
 */
export interface CronExecutionContext {
  /** The job being executed */
  job: CronJob;
  /** Timestamp when execution started */
  startedAtMs: number;
  /** Abort signal for timeout handling */
  signal: AbortSignal;
}
