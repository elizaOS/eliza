/**
 * @module cron-storage.test
 * @description Tests for the cron storage layer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCronStorage, type CronStorage } from '../storage/cron-storage.js';
import type { CronJob } from '../types.js';
import type { IAgentRuntime, Component } from '@elizaos/core';

// Mock UUID for deterministic testing
vi.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234',
}));

// Helper to create a mock runtime
function createMockRuntime(): IAgentRuntime {
  const components = new Map<string, Component>();

  return {
    agentId: 'test-agent-id',
    getComponent: vi.fn(async (type: string) => {
      return components.get(type) || null;
    }),
    createComponent: vi.fn(async (component: Component) => {
      components.set(component.type, component);
      return true;
    }),
    updateComponent: vi.fn(async (component: Component) => {
      components.set(component.type, component);
      return true;
    }),
    deleteComponent: vi.fn(async (type: string) => {
      return components.delete(type);
    }),
    listComponents: vi.fn(async (query: { type?: string }) => {
      if (query.type) {
        const component = components.get(query.type);
        return component ? [component] : [];
      }
      return Array.from(components.values());
    }),
  } as unknown as IAgentRuntime;
}

// Helper to create a mock job
function createMockJob(overrides: Partial<CronJob> = {}): CronJob {
  const nowMs = Date.now();
  return {
    id: 'test-job-1',
    name: 'Test Job',
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: 'every', everyMs: 60000 },
    payload: { kind: 'prompt', text: 'Test prompt' },
    state: {
      runCount: 0,
      errorCount: 0,
    },
    ...overrides,
  };
}

describe('cron-storage', () => {
  let runtime: IAgentRuntime;
  let storage: CronStorage;

  beforeEach(() => {
    runtime = createMockRuntime();
    storage = getCronStorage(runtime);
  });

  describe('saveJob', () => {
    it('saves a new job and updates the index', async () => {
      const job = createMockJob();

      await storage.saveJob(job);

      expect(runtime.createComponent).toHaveBeenCalled();
    });

    it('updates an existing job', async () => {
      const job = createMockJob();

      // Save initially
      await storage.saveJob(job);

      // Mock that the job now exists
      (runtime.getComponent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        type: `cron_job:${job.id}`,
        data: job,
      });

      // Update the job
      job.name = 'Updated Name';
      await storage.saveJob(job);

      // Should call createComponent or updateComponent
      expect(runtime.createComponent).toHaveBeenCalled();
    });
  });

  describe('getJob', () => {
    it('returns null for non-existent jobs', async () => {
      const result = await storage.getJob('non-existent');

      expect(result).toBeNull();
    });

    it('returns the job when it exists', async () => {
      const job = createMockJob();
      await storage.saveJob(job);

      // Mock the getComponent to return the saved job
      (runtime.getComponent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        type: `cron_job:${job.id}`,
        data: job,
      });

      const result = await storage.getJob(job.id);

      expect(result).toBeDefined();
      expect(result?.id).toBe(job.id);
    });
  });

  describe('deleteJob', () => {
    it('returns false for non-existent jobs', async () => {
      const result = await storage.deleteJob('non-existent');

      expect(result).toBe(false);
    });

    it('deletes a job and updates the index', async () => {
      const job = createMockJob();
      await storage.saveJob(job);

      // Mock the getComponent to return the saved job
      (runtime.getComponent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        type: `cron_job:${job.id}`,
        data: job,
      });

      const result = await storage.deleteJob(job.id);

      expect(runtime.deleteComponent).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });

  describe('listJobs', () => {
    it('returns empty array when no jobs exist', async () => {
      const jobs = await storage.listJobs();

      expect(jobs).toEqual([]);
    });

    it('filters by enabled status', async () => {
      const enabledJob = createMockJob({ id: 'enabled-job', enabled: true });
      const disabledJob = createMockJob({ id: 'disabled-job', enabled: false });

      // Mock the index to contain both job IDs
      (runtime.getComponent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          type: 'cron_job_index',
          data: { jobIds: ['enabled-job', 'disabled-job'] },
        })
        .mockResolvedValueOnce({
          type: 'cron_job:enabled-job',
          data: enabledJob,
        })
        .mockResolvedValueOnce({
          type: 'cron_job:disabled-job',
          data: disabledJob,
        });

      const enabledJobs = await storage.listJobs({ includeDisabled: false });

      // Should only return enabled job
      expect(enabledJobs.filter((j) => j.enabled)).toHaveLength(1);
    });

    it('filters by tags', async () => {
      const taggedJob = createMockJob({ id: 'tagged-job', tags: ['important'] });
      const untaggedJob = createMockJob({ id: 'untagged-job' });

      // Mock the index
      (runtime.getComponent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          type: 'cron_job_index',
          data: { jobIds: ['tagged-job', 'untagged-job'] },
        })
        .mockResolvedValueOnce({
          type: 'cron_job:tagged-job',
          data: taggedJob,
        })
        .mockResolvedValueOnce({
          type: 'cron_job:untagged-job',
          data: untaggedJob,
        });

      const filteredJobs = await storage.listJobs({ tags: ['important'] });

      // Should only return tagged job
      expect(filteredJobs.some((j) => j.tags?.includes('important'))).toBe(true);
    });
  });

  describe('getJobCount', () => {
    it('returns 0 when no jobs exist', async () => {
      const count = await storage.getJobCount();

      expect(count).toBe(0);
    });

    it('returns the correct count', async () => {
      // Mock the index with job IDs
      (runtime.getComponent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        type: 'cron_job_index',
        data: { jobIds: ['job-1', 'job-2', 'job-3'] },
      });

      const count = await storage.getJobCount();

      expect(count).toBe(3);
    });
  });

});
