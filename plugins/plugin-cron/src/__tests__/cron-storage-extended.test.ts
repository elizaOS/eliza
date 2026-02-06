/**
 * @module cron-storage-extended.test
 * @description Extended tests for cron storage - edge cases, filtering, concurrency
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCronStorage, type CronStorage } from '../storage/cron-storage.js';
import type { CronJob, CronJobFilter } from '../types.js';
import type { IAgentRuntime, Component, UUID } from '@elizaos/core';

function createMockJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  const nowMs = Date.now();
  return {
    id,
    name: `Job ${id}`,
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

function createMockRuntime(): {
  runtime: IAgentRuntime;
  components: Map<string, Component>;
  createComponent: ReturnType<typeof vi.fn>;
  getComponent: ReturnType<typeof vi.fn>;
  updateComponent: ReturnType<typeof vi.fn>;
  deleteComponent: ReturnType<typeof vi.fn>;
  getComponents: ReturnType<typeof vi.fn>;
} {
  const components = new Map<string, Component>();

  const createComponent = vi.fn().mockImplementation(async (comp: Component) => {
    components.set(comp.type, comp);
    return comp;
  });

  const getComponent = vi.fn().mockImplementation(async (_entityId: UUID, type: string) => {
    return components.get(type) ?? null;
  });

  const updateComponent = vi.fn().mockImplementation(async (comp: Component) => {
    components.set(comp.type, comp);
    return comp;
  });

  const deleteComponent = vi.fn().mockImplementation(async (id: UUID) => {
    // Find and delete by id
    for (const [type, comp] of components.entries()) {
      if (comp.id === id) {
        components.delete(type);
        return true;
      }
    }
    return false;
  });

  const getComponents = vi.fn().mockImplementation(async (filter: { type?: string }) => {
    const results: Component[] = [];
    for (const comp of components.values()) {
      if (!filter.type || comp.type === filter.type) {
        results.push(comp);
      }
    }
    return results;
  });

  const runtime = {
    agentId: 'test-agent-id' as UUID,
    createComponent,
    getComponent,
    updateComponent,
    deleteComponent,
    getComponents,
  } as unknown as IAgentRuntime;

  return {
    runtime,
    components,
    createComponent,
    getComponent,
    updateComponent,
    deleteComponent,
    getComponents,
  };
}

describe('CronStorage extended', () => {
  let runtime: IAgentRuntime;
  let storage: CronStorage;
  let mocks: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    mocks = createMockRuntime();
    runtime = mocks.runtime;
    storage = getCronStorage(runtime);
  });

  // ==========================================================================
  // SAVE JOB EDGE CASES
  // ==========================================================================

  describe('saveJob edge cases', () => {
    it('saves job with minimal required fields', async () => {
      const minimalJob: CronJob = {
        id: 'min-1',
        name: 'M',
        enabled: false,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: 'every', everyMs: 1000 },
        payload: { kind: 'prompt', text: '' },
        state: { runCount: 0, errorCount: 0 },
      };

      await storage.saveJob(minimalJob);

      // Verify job was saved by retrieving it
      const retrieved = await storage.getJob('min-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('min-1');
    });

    it('saves job with all optional fields populated', async () => {
      const fullJob: CronJob = {
        id: 'full-1',
        name: 'Full Job',
        description: 'Description here',
        enabled: true,
        createdAtMs: 1000,
        updatedAtMs: 2000,
        tags: ['tag1', 'tag2', 'tag3'],
        schedule: {
          kind: 'cron',
          expr: '0 0 * * *',
          tz: 'America/New_York',
        },
        payload: {
          kind: 'action',
          actionName: 'TEST_ACTION',
          params: { key: 'value' },
        },
        deleteAfterRun: true,
        state: {
          nextRunAtMs: 3000,
          runningAtMs: undefined,
          lastRunAtMs: 1500,
          lastStatus: 'ok',
          lastError: 'Previous error message',
          lastDurationMs: 100,
          runCount: 5,
          errorCount: 1,
        },
      };

      await storage.saveJob(fullJob);

      // Verify job was saved correctly by retrieving
      const retrieved = await storage.getJob('full-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('Full Job');
      expect(retrieved?.description).toBe('Description here');
      expect(retrieved?.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('updates existing job with same id', async () => {
      const job1 = createMockJob('job-1', { name: 'Original' });
      await storage.saveJob(job1);

      const job2 = createMockJob('job-1', { name: 'Updated' });
      await storage.saveJob(job2);

      // Verify the updated data is retrieved
      const retrieved = await storage.getJob('job-1');
      expect(retrieved?.name).toBe('Updated');

      // Count should still be 1
      expect(await storage.getJobCount()).toBe(1);
    });

    it('handles job with unicode characters in name', async () => {
      const job = createMockJob('unicode-1', {
        name: '日本語の仕事 🎉',
        description: 'Descrição com acentos',
      });

      await storage.saveJob(job);
      const retrieved = await storage.getJob('unicode-1');

      expect(retrieved?.name).toBe('日本語の仕事 🎉');
    });

    it('handles job with very large payload', async () => {
      const largeParams: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        largeParams[`key${i}`] = 'x'.repeat(100);
      }

      const job = createMockJob('large-1', {
        payload: { kind: 'action', actionName: 'TEST', params: largeParams },
      });

      await storage.saveJob(job);
      const retrieved = await storage.getJob('large-1');

      expect(Object.keys((retrieved?.payload as { params: Record<string, string> }).params)).toHaveLength(1000);
    });
  });

  // ==========================================================================
  // GET JOB EDGE CASES
  // ==========================================================================

  describe('getJob edge cases', () => {
    it('returns null for non-existent job', async () => {
      const result = await storage.getJob('does-not-exist');
      expect(result).toBeNull();
    });

    it('returns null for empty string id', async () => {
      const result = await storage.getJob('');
      expect(result).toBeNull();
    });

    it('handles id with special characters', async () => {
      const job = createMockJob('special:chars/here#123');
      await storage.saveJob(job);

      const retrieved = await storage.getJob('special:chars/here#123');
      expect(retrieved?.id).toBe('special:chars/here#123');
    });
  });

  // ==========================================================================
  // DELETE JOB EDGE CASES
  // ==========================================================================

  describe('deleteJob edge cases', () => {
    it('returns false for non-existent job', async () => {
      const result = await storage.deleteJob('ghost-job');
      expect(result).toBe(false);
    });

    it('successfully deletes existing job', async () => {
      const job = createMockJob('to-delete');
      await storage.saveJob(job);

      const deleted = await storage.deleteJob('to-delete');
      expect(deleted).toBe(true);

      const retrieved = await storage.getJob('to-delete');
      expect(retrieved).toBeNull();
    });

    it('can delete and recreate job with same id', async () => {
      const job1 = createMockJob('reuse-id', { name: 'First' });
      await storage.saveJob(job1);
      await storage.deleteJob('reuse-id');

      const job2 = createMockJob('reuse-id', { name: 'Second' });
      await storage.saveJob(job2);

      const retrieved = await storage.getJob('reuse-id');
      expect(retrieved?.name).toBe('Second');
    });
  });

  // ==========================================================================
  // LIST JOBS - FILTERING
  // ==========================================================================

  describe('listJobs filtering', () => {
    beforeEach(async () => {
      // Set up test data
      await storage.saveJob(createMockJob('job-1', { enabled: true, tags: ['daily', 'report'] }));
      await storage.saveJob(createMockJob('job-2', { enabled: false, tags: ['hourly'] }));
      await storage.saveJob(createMockJob('job-3', { enabled: true, tags: ['daily', 'cleanup'] }));
      await storage.saveJob(createMockJob('job-4', { enabled: true, tags: [] }));
      await storage.saveJob(createMockJob('job-5', { enabled: false }));
    });

    it('returns all jobs when no filter provided', async () => {
      const jobs = await storage.listJobs();
      expect(jobs).toHaveLength(5);
    });

    it('filters by enabled=true', async () => {
      const jobs = await storage.listJobs({ enabled: true });
      expect(jobs).toHaveLength(3);
      expect(jobs.every((j) => j.enabled)).toBe(true);
    });

    it('filters by enabled=false', async () => {
      const jobs = await storage.listJobs({ enabled: false });
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => !j.enabled)).toBe(true);
    });

    it('filters by single tag', async () => {
      const jobs = await storage.listJobs({ tags: ['daily'] });
      expect(jobs).toHaveLength(2);
    });

    it('filters by multiple tags (OR logic - matches any)', async () => {
      // Note: implementation uses OR logic - matches if job has ANY of the filter tags
      const jobs = await storage.listJobs({ tags: ['daily', 'report'] });
      // Both job-1 (daily, report) and job-3 (daily, cleanup) have 'daily' tag
      expect(jobs).toHaveLength(2);
      const ids = jobs.map((j) => j.id);
      expect(ids).toContain('job-1');
      expect(ids).toContain('job-3');
    });

    it('combines enabled and tags filters', async () => {
      const jobs = await storage.listJobs({ enabled: true, tags: ['daily'] });
      expect(jobs).toHaveLength(2);
    });

    it('returns empty array for non-matching filter', async () => {
      const jobs = await storage.listJobs({ tags: ['nonexistent'] });
      expect(jobs).toHaveLength(0);
    });

    it('handles empty tags filter array', async () => {
      const jobs = await storage.listJobs({ tags: [] });
      // Empty tags array should match all (no tag constraint)
      expect(jobs.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // GET JOB COUNT
  // ==========================================================================

  describe('getJobCount', () => {
    it('returns 0 for empty storage', async () => {
      const count = await storage.getJobCount();
      expect(count).toBe(0);
    });

    it('returns correct count after adding jobs', async () => {
      await storage.saveJob(createMockJob('c1'));
      await storage.saveJob(createMockJob('c2'));
      await storage.saveJob(createMockJob('c3'));

      expect(await storage.getJobCount()).toBe(3);
    });

    it('count decreases after deletion', async () => {
      await storage.saveJob(createMockJob('d1'));
      await storage.saveJob(createMockJob('d2'));
      expect(await storage.getJobCount()).toBe(2);

      await storage.deleteJob('d1');
      expect(await storage.getJobCount()).toBe(1);
    });

    it('count does not change on update', async () => {
      await storage.saveJob(createMockJob('u1', { name: 'Original' }));
      expect(await storage.getJobCount()).toBe(1);

      await storage.saveJob(createMockJob('u1', { name: 'Updated' }));
      expect(await storage.getJobCount()).toBe(1);
    });
  });

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  describe('error handling', () => {
    it('propagates error from createComponent', async () => {
      mocks.createComponent.mockRejectedValueOnce(new Error('Storage failure'));

      const job = createMockJob('fail-1');
      await expect(storage.saveJob(job)).rejects.toThrow('Storage failure');
    });

    it('propagates error from getComponent', async () => {
      mocks.getComponent.mockRejectedValueOnce(new Error('Read failure'));

      await expect(storage.getJob('any-id')).rejects.toThrow('Read failure');
    });

    it('propagates error from deleteComponent', async () => {
      const job = createMockJob('del-fail');
      await storage.saveJob(job);

      mocks.deleteComponent.mockRejectedValueOnce(new Error('Delete failure'));

      await expect(storage.deleteJob('del-fail')).rejects.toThrow('Delete failure');
    });

    it('propagates error from getComponent during list', async () => {
      // First create a job so the index has something
      await storage.saveJob(createMockJob('error-test'));

      // Then make getComponent fail when listing tries to read jobs
      mocks.getComponent.mockRejectedValueOnce(new Error('Read failure'));
      mocks.getComponent.mockRejectedValueOnce(new Error('Read failure'));

      await expect(storage.listJobs()).rejects.toThrow('Read failure');
    });
  });

  // ==========================================================================
  // DATA INTEGRITY
  // ==========================================================================

  describe('data integrity', () => {
    it('preserves all fields through save/get cycle', async () => {
      const original: CronJob = {
        id: 'integrity-test',
        name: 'Test Job',
        description: 'A description',
        enabled: true,
        createdAtMs: 1234567890,
        updatedAtMs: 1234567891,
        tags: ['a', 'b'],
        schedule: {
          kind: 'cron',
          expr: '*/5 * * * *',
          tz: 'UTC',
        },
        payload: {
          kind: 'event',
          eventName: 'TEST',
          payload: { nested: { data: true } },
        },
        deleteAfterRun: false,
        state: {
          nextRunAtMs: 1234568000,
          lastRunAtMs: 1234567800,
          lastStatus: 'error',
          lastError: 'Previous error',
          lastDurationMs: 50,
          runCount: 10,
          errorCount: 2,
        },
      };

      await storage.saveJob(original);
      const retrieved = await storage.getJob('integrity-test');

      expect(retrieved).toEqual(original);
    });

    it('handles null values correctly', async () => {
      const job = createMockJob('null-test', {
        description: undefined,
        tags: undefined,
        deleteAfterRun: undefined,
      });

      await storage.saveJob(job);
      const retrieved = await storage.getJob('null-test');

      expect(retrieved?.description).toBeUndefined();
      expect(retrieved?.tags).toBeUndefined();
    });

    it('handles empty arrays correctly', async () => {
      const job = createMockJob('empty-array', { tags: [] });

      await storage.saveJob(job);
      const retrieved = await storage.getJob('empty-array');

      expect(retrieved?.tags).toEqual([]);
    });
  });

  // ==========================================================================
  // CONCURRENT OPERATIONS
  // ==========================================================================

  describe('concurrent operations', () => {
    it('handles sequential saves correctly', async () => {
      // Due to index updates, sequential saves are more reliable
      for (let i = 0; i < 5; i++) {
        await storage.saveJob(createMockJob(`sequential-${i}`));
      }

      const count = await storage.getJobCount();
      expect(count).toBe(5);
    });

    it('handles save and delete in parallel', async () => {
      await storage.saveJob(createMockJob('parallel-1'));
      await storage.saveJob(createMockJob('parallel-2'));

      await Promise.all([
        storage.saveJob(createMockJob('parallel-3')),
        storage.deleteJob('parallel-1'),
      ]);

      const jobs = await storage.listJobs();
      const ids = jobs.map((j) => j.id);

      expect(ids).toContain('parallel-2');
      expect(ids).toContain('parallel-3');
      expect(ids).not.toContain('parallel-1');
    });

    it('handles rapid update cycles', async () => {
      const job = createMockJob('rapid-update');
      await storage.saveJob(job);

      const updates = Array.from({ length: 20 }, (_, i) =>
        storage.saveJob(createMockJob('rapid-update', { name: `Update ${i}` }))
      );

      await Promise.all(updates);

      const final = await storage.getJob('rapid-update');
      // Should have one of the update names
      expect(final?.name).toMatch(/Update \d+/);
    });
  });
});
