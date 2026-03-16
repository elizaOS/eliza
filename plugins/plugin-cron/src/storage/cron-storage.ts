/**
 * @module cron-storage
 * @description Component-based persistence for cron job data using elizaOS Components
 *
 * Storage strategy:
 * - Each job is stored as a separate component with type "cron_job:{jobId}"
 * - An index component "cron_job_index" tracks all job IDs for efficient listing
 * - All components are scoped to the agent (entityId = agentId)
 * - Index operations are serialized using an async mutex to prevent race conditions
 */

import type { IAgentRuntime, UUID, Component, Metadata } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type { CronJob, CronJobFilter } from '../types.js';
import { CRON_JOB_COMPONENT_PREFIX, CRON_JOB_INDEX_COMPONENT } from '../constants.js';

/**
 * Simple async mutex for serializing index operations
 * This prevents race conditions when multiple concurrent saves try to update the index
 */
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = (): void => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

// Per-agent mutexes for index operations
const indexMutexes = new Map<string, AsyncMutex>();

function getIndexMutex(agentId: string): AsyncMutex {
  let mutex = indexMutexes.get(agentId);
  if (!mutex) {
    mutex = new AsyncMutex();
    indexMutexes.set(agentId, mutex);
  }
  return mutex;
}

/**
 * Index structure that tracks all job IDs for an agent
 */
interface CronJobIndex {
  jobIds: string[];
}

/**
 * Gets the component type string for a specific job
 */
function getJobComponentType(jobId: string): string {
  return `${CRON_JOB_COMPONENT_PREFIX}:${jobId}`;
}

/**
 * Retrieves the job index for an agent
 */
async function getJobIndex(runtime: IAgentRuntime): Promise<CronJobIndex> {
  const component = await runtime.getComponent(runtime.agentId, CRON_JOB_INDEX_COMPONENT);
  if (!component) {
    return { jobIds: [] };
  }
  return component.data as unknown as CronJobIndex;
}

/**
 * Saves the job index for an agent
 */
async function saveJobIndex(runtime: IAgentRuntime, index: CronJobIndex): Promise<void> {
  const existing = await runtime.getComponent(runtime.agentId, CRON_JOB_INDEX_COMPONENT);

  const component: Component = {
    id: existing?.id || (uuidv4() as UUID),
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    roomId: runtime.agentId, // Use agentId as room for agent-scoped data
    worldId: existing?.worldId || (uuidv4() as UUID),
    sourceEntityId: runtime.agentId,
    type: CRON_JOB_INDEX_COMPONENT,
    createdAt: existing?.createdAt || Date.now(),
    data: index as unknown as Metadata,
  };

  if (existing) {
    await runtime.updateComponent(component);
  } else {
    await runtime.createComponent(component);
  }
}

/**
 * Adds a job ID to the index (mutex-protected to prevent race conditions)
 */
async function addToIndex(runtime: IAgentRuntime, jobId: string): Promise<void> {
  const mutex = getIndexMutex(runtime.agentId as string);
  const release = await mutex.acquire();
  try {
    // Re-read index inside mutex to ensure we have the latest
    const index = await getJobIndex(runtime);
    if (!index.jobIds.includes(jobId)) {
      index.jobIds.push(jobId);
      await saveJobIndex(runtime, index);
    }
  } finally {
    release();
  }
}

/**
 * Removes a job ID from the index (mutex-protected to prevent race conditions)
 */
async function removeFromIndex(runtime: IAgentRuntime, jobId: string): Promise<void> {
  const mutex = getIndexMutex(runtime.agentId as string);
  const release = await mutex.acquire();
  try {
    // Re-read index inside mutex to ensure we have the latest
    const index = await getJobIndex(runtime);
    const filtered = index.jobIds.filter((id) => id !== jobId);
    if (filtered.length !== index.jobIds.length) {
      index.jobIds = filtered;
      await saveJobIndex(runtime, index);
    }
  } finally {
    release();
  }
}

/**
 * Validates that the data has the required CronJob structure
 * @returns The validated job or null if invalid
 */
function validateJobData(data: unknown): CronJob | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Required fields validation
  if (typeof obj.id !== 'string' || !obj.id) {
    return null;
  }
  if (typeof obj.name !== 'string' || !obj.name) {
    return null;
  }
  if (typeof obj.createdAtMs !== 'number') {
    return null;
  }
  if (typeof obj.updatedAtMs !== 'number') {
    return null;
  }

  // Validate schedule
  if (!obj.schedule || typeof obj.schedule !== 'object') {
    return null;
  }
  const schedule = obj.schedule as Record<string, unknown>;
  const validScheduleKinds = ['at', 'every', 'cron'];
  if (!validScheduleKinds.includes(schedule.kind as string)) {
    return null;
  }

  // Validate payload
  if (!obj.payload || typeof obj.payload !== 'object') {
    return null;
  }
  const payload = obj.payload as Record<string, unknown>;
  const validPayloadKinds = ['prompt', 'action', 'event'];
  if (!validPayloadKinds.includes(payload.kind as string)) {
    return null;
  }

  // Validate state
  if (!obj.state || typeof obj.state !== 'object') {
    return null;
  }
  const state = obj.state as Record<string, unknown>;
  if (typeof state.runCount !== 'number' || typeof state.errorCount !== 'number') {
    return null;
  }

  // Apply defaults for optional boolean fields
  const job = {
    ...(data as CronJob),
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    deleteAfterRun: typeof obj.deleteAfterRun === 'boolean' ? obj.deleteAfterRun : false,
  };

  return job;
}

/**
 * Checks if a job matches the given filter criteria
 */
function matchesFilter(job: CronJob, filter?: CronJobFilter): boolean {
  if (!filter) return true;

  // Filter by enabled status (explicit filter takes precedence)
  if (filter.enabled !== undefined) {
    if (job.enabled !== filter.enabled) return false;
  } else if (!filter.includeDisabled && !job.enabled) {
    // Default: exclude disabled unless explicitly included
    return false;
  }

  // Filter by tags (matches if job has any of the filter tags)
  if (filter.tags?.length) {
    if (!job.tags?.some((tag) => filter.tags!.includes(tag))) return false;
  }

  return true;
}

/**
 * Storage interface for cron job operations
 */
export interface CronStorage {
  /**
   * Retrieves a job by ID
   * @returns The job or null if not found
   */
  getJob(jobId: string): Promise<CronJob | null>;

  /**
   * Saves a job (creates or updates)
   */
  saveJob(job: CronJob): Promise<void>;

  /**
   * Deletes a job by ID
   * @returns true if the job was deleted, false if it didn't exist
   */
  deleteJob(jobId: string): Promise<boolean>;

  /**
   * Lists all jobs, optionally filtered
   * @param filter Optional filter criteria
   * @returns Array of matching jobs, sorted by next run time
   */
  listJobs(filter?: CronJobFilter): Promise<CronJob[]>;

  /**
   * Gets the total count of jobs for the agent
   */
  getJobCount(): Promise<number>;

  /**
   * Checks if a job exists
   */
  hasJob(jobId: string): Promise<boolean>;
}

/**
 * Creates a storage instance for cron job operations
 * @param runtime The agent runtime to use for component storage
 */
export function getCronStorage(runtime: IAgentRuntime): CronStorage {
  return {
    async getJob(jobId: string): Promise<CronJob | null> {
      const componentType = getJobComponentType(jobId);
      const component = await runtime.getComponent(runtime.agentId, componentType);
      if (!component) {
        return null;
      }
      // Validate the stored data to protect against corrupted data
      const validatedJob = validateJobData(component.data);
      if (!validatedJob) {
        // Log warning and return null for corrupted data rather than crashing
        console.warn(`[cron-storage] Invalid job data for ${jobId}, skipping`);
        return null;
      }
      return validatedJob;
    },

    async saveJob(job: CronJob): Promise<void> {
      const componentType = getJobComponentType(job.id);
      const existing = await runtime.getComponent(runtime.agentId, componentType);

      const component: Component = {
        id: existing?.id || (uuidv4() as UUID),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        worldId: existing?.worldId || (uuidv4() as UUID),
        sourceEntityId: runtime.agentId,
        type: componentType,
        createdAt: existing?.createdAt || job.createdAtMs,
        data: job as unknown as Metadata,
      };

      if (existing) {
        await runtime.updateComponent(component);
      } else {
        await runtime.createComponent(component);
        await addToIndex(runtime, job.id);
      }
    },

    async deleteJob(jobId: string): Promise<boolean> {
      const componentType = getJobComponentType(jobId);
      const existing = await runtime.getComponent(runtime.agentId, componentType);

      if (!existing) {
        return false;
      }

      await runtime.deleteComponent(existing.id);
      await removeFromIndex(runtime, jobId);
      return true;
    },

    async listJobs(filter?: CronJobFilter): Promise<CronJob[]> {
      const index = await getJobIndex(runtime);
      const jobs: CronJob[] = [];

      for (const jobId of index.jobIds) {
        const job = await this.getJob(jobId);
        if (job && matchesFilter(job, filter)) {
          jobs.push(job);
        }
      }

      // Sort by next run time (jobs without next run time go to the end)
      jobs.sort((a, b) => {
        const aNext = a.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        const bNext = b.state.nextRunAtMs ?? Number.MAX_SAFE_INTEGER;
        return aNext - bNext;
      });

      return jobs;
    },

    async getJobCount(): Promise<number> {
      const index = await getJobIndex(runtime);
      return index.jobIds.length;
    },

    async hasJob(jobId: string): Promise<boolean> {
      const index = await getJobIndex(runtime);
      return index.jobIds.includes(jobId);
    },
  };
}
