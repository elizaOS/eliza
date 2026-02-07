/**
 * @module storage.real.test
 * @description Real storage logic tests for CronStorage — exercises actual
 * CRUD operations, filtering, indexing, duplicate handling, and job limits
 * using an in-memory mock runtime that faithfully simulates component storage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCronStorage, type CronStorage } from '../storage/cron-storage.js';
import { isJobDue, computeNextRunAtMs } from '../scheduler/schedule-utils.js';
import type { CronJob, CronJobFilter, CronServiceConfig } from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';
import type { IAgentRuntime, Component, UUID, Metadata } from '@elizaos/core';

// ============================================================================
// Realistic in-memory runtime mock (simulates component storage faithfully)
// ============================================================================

function createInMemoryRuntime(): IAgentRuntime {
  const components = new Map<string, Component>();
  const agentId = 'test-agent-real' as UUID;

  return {
    agentId,

    getComponent: vi.fn(async (_entityId: UUID, type: string) => {
      return components.get(type) ?? null;
    }),

    createComponent: vi.fn(async (comp: Component) => {
      components.set(comp.type, comp);
      return comp;
    }),

    updateComponent: vi.fn(async (comp: Component) => {
      components.set(comp.type, comp);
      return comp;
    }),

    deleteComponent: vi.fn(async (id: UUID) => {
      for (const [type, comp] of components.entries()) {
        if (comp.id === id) {
          components.delete(type);
          return true;
        }
      }
      return false;
    }),
  } as unknown as IAgentRuntime;
}

// ============================================================================
// Helper to create well-formed jobs
// ============================================================================

let jobCounter = 0;

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  jobCounter++;
  const nowMs = Date.now();
  return {
    id: `job-${jobCounter}`,
    name: `Test Job ${jobCounter}`,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: 'every', everyMs: 60000 },
    payload: { kind: 'prompt', text: 'Hello' },
    state: { runCount: 0, errorCount: 0 },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('CronStorage real operations', () => {
  let runtime: IAgentRuntime;
  let storage: CronStorage;

  beforeEach(() => {
    jobCounter = 0;
    runtime = createInMemoryRuntime();
    storage = getCronStorage(runtime);
  });

  // --------------------------------------------------------------------------
  // 1. Add job and get it back
  // --------------------------------------------------------------------------

  it('adds a job and retrieves it by ID', async () => {
    const job = makeJob({ id: 'add-get-1', name: 'AddGetTest' });
    await storage.saveJob(job);

    const retrieved = await storage.getJob('add-get-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('add-get-1');
    expect(retrieved?.name).toBe('AddGetTest');
    expect(retrieved?.schedule.kind).toBe('every');
  });

  // --------------------------------------------------------------------------
  // 2. Get non-existent job returns null
  // --------------------------------------------------------------------------

  it('returns null for a job ID that does not exist', async () => {
    const result = await storage.getJob('does-not-exist');
    expect(result).toBeNull();
  });

  // --------------------------------------------------------------------------
  // 3. Update job (save with same ID)
  // --------------------------------------------------------------------------

  it('updates a job when saved with the same ID', async () => {
    const job = makeJob({ id: 'update-1', name: 'Original' });
    await storage.saveJob(job);

    const updated = makeJob({ id: 'update-1', name: 'Updated' });
    await storage.saveJob(updated);

    const retrieved = await storage.getJob('update-1');
    expect(retrieved?.name).toBe('Updated');

    // Count should still be 1 — not duplicated
    const count = await storage.getJobCount();
    expect(count).toBe(1);
  });

  // --------------------------------------------------------------------------
  // 4. Delete job
  // --------------------------------------------------------------------------

  it('deletes a job and verifies it is gone', async () => {
    const job = makeJob({ id: 'delete-1' });
    await storage.saveJob(job);
    expect(await storage.getJob('delete-1')).not.toBeNull();

    const deleted = await storage.deleteJob('delete-1');
    expect(deleted).toBe(true);

    expect(await storage.getJob('delete-1')).toBeNull();
    expect(await storage.getJobCount()).toBe(0);
  });

  it('returns false when deleting a non-existent job', async () => {
    const result = await storage.deleteJob('ghost');
    expect(result).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 5. List with enabled/disabled filter
  // --------------------------------------------------------------------------

  it('filters jobs by enabled state', async () => {
    await storage.saveJob(makeJob({ id: 'e1', enabled: true }));
    await storage.saveJob(makeJob({ id: 'e2', enabled: false }));
    await storage.saveJob(makeJob({ id: 'e3', enabled: true }));

    const enabledOnly = await storage.listJobs({ enabled: true });
    expect(enabledOnly.length).toBe(2);
    expect(enabledOnly.every((j) => j.enabled)).toBe(true);

    const disabledOnly = await storage.listJobs({ enabled: false });
    expect(disabledOnly.length).toBe(1);
    expect(disabledOnly[0].id).toBe('e2');
  });

  // --------------------------------------------------------------------------
  // 6. List with tag filter
  // --------------------------------------------------------------------------

  it('filters jobs by tags', async () => {
    await storage.saveJob(makeJob({ id: 't1', tags: ['report', 'daily'] }));
    await storage.saveJob(makeJob({ id: 't2', tags: ['cleanup'] }));
    await storage.saveJob(makeJob({ id: 't3', tags: ['daily'] }));
    await storage.saveJob(makeJob({ id: 't4' })); // no tags

    const dailyJobs = await storage.listJobs({ tags: ['daily'] });
    expect(dailyJobs.length).toBe(2);

    const ids = dailyJobs.map((j) => j.id);
    expect(ids).toContain('t1');
    expect(ids).toContain('t3');
  });

  // --------------------------------------------------------------------------
  // 7. Get due jobs — combine listJobs + isJobDue
  // --------------------------------------------------------------------------

  it('identifies due jobs using real scheduling logic', async () => {
    const nowMs = Date.now();

    // Job with nextRunAtMs in the past (due)
    await storage.saveJob(
      makeJob({
        id: 'due-1',
        state: { runCount: 0, errorCount: 0, nextRunAtMs: nowMs - 5000 },
      })
    );

    // Job with nextRunAtMs in the future (not due)
    await storage.saveJob(
      makeJob({
        id: 'due-2',
        state: { runCount: 0, errorCount: 0, nextRunAtMs: nowMs + 60000 },
      })
    );

    // Job with no nextRunAtMs (not due)
    await storage.saveJob(
      makeJob({
        id: 'due-3',
        state: { runCount: 0, errorCount: 0 },
      })
    );

    const allJobs = await storage.listJobs();
    const dueJobs = allJobs.filter((j) => isJobDue(j.state.nextRunAtMs, nowMs));

    expect(dueJobs.length).toBe(1);
    expect(dueJobs[0].id).toBe('due-1');
  });

  // --------------------------------------------------------------------------
  // 8. Duplicate name handling — same name, different IDs are allowed
  // --------------------------------------------------------------------------

  it('allows multiple jobs with the same name but different IDs', async () => {
    await storage.saveJob(makeJob({ id: 'dup-a', name: 'Daily Report' }));
    await storage.saveJob(makeJob({ id: 'dup-b', name: 'Daily Report' }));

    const count = await storage.getJobCount();
    expect(count).toBe(2);

    const jobs = await storage.listJobs();
    const names = jobs.map((j) => j.name);
    expect(names.filter((n) => n === 'Daily Report').length).toBe(2);
  });

  // --------------------------------------------------------------------------
  // 9. Max jobs limit check via getJobCount
  // --------------------------------------------------------------------------

  it('tracks job count accurately for max-job enforcement', async () => {
    const maxJobs = DEFAULT_CRON_CONFIG.maxJobsPerAgent; // 100

    // Add 5 jobs
    for (let i = 0; i < 5; i++) {
      await storage.saveJob(makeJob({ id: `limit-${i}` }));
    }
    expect(await storage.getJobCount()).toBe(5);

    // Simulate a limit check: count < maxJobs
    const count = await storage.getJobCount();
    expect(count < maxJobs).toBe(true);

    // Delete 2, verify count decreases
    await storage.deleteJob('limit-0');
    await storage.deleteJob('limit-1');
    expect(await storage.getJobCount()).toBe(3);
  });

  // --------------------------------------------------------------------------
  // 10. hasJob utility
  // --------------------------------------------------------------------------

  it('hasJob returns true for existing and false for deleted', async () => {
    const job = makeJob({ id: 'has-1' });
    await storage.saveJob(job);

    expect(await storage.hasJob('has-1')).toBe(true);
    expect(await storage.hasJob('nonexistent')).toBe(false);

    await storage.deleteJob('has-1');
    expect(await storage.hasJob('has-1')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // 11. List returns jobs sorted by nextRunAtMs
  // --------------------------------------------------------------------------

  it('lists jobs sorted by next run time (earliest first)', async () => {
    const nowMs = Date.now();

    await storage.saveJob(
      makeJob({
        id: 'sort-c',
        state: { runCount: 0, errorCount: 0, nextRunAtMs: nowMs + 30000 },
      })
    );
    await storage.saveJob(
      makeJob({
        id: 'sort-a',
        state: { runCount: 0, errorCount: 0, nextRunAtMs: nowMs + 10000 },
      })
    );
    await storage.saveJob(
      makeJob({
        id: 'sort-b',
        state: { runCount: 0, errorCount: 0, nextRunAtMs: nowMs + 20000 },
      })
    );

    const jobs = await storage.listJobs();
    expect(jobs[0].id).toBe('sort-a');
    expect(jobs[1].id).toBe('sort-b');
    expect(jobs[2].id).toBe('sort-c');
  });

  // --------------------------------------------------------------------------
  // 12. Data integrity through save/get cycle
  // --------------------------------------------------------------------------

  it('preserves all job fields through a save/get round trip', async () => {
    const original: CronJob = {
      id: 'integrity-1',
      name: 'Full Test',
      description: 'A comprehensive job',
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: 1700000000000,
      updatedAtMs: 1700000001000,
      tags: ['alpha', 'beta'],
      schedule: { kind: 'cron', expr: '*/10 * * * *', tz: 'Europe/Berlin' },
      payload: {
        kind: 'action',
        actionName: 'SEND_REPORT',
        params: { format: 'pdf', recipients: ['alice', 'bob'] },
      },
      state: {
        nextRunAtMs: 1700000060000,
        lastRunAtMs: 1700000000000,
        lastStatus: 'ok',
        lastDurationMs: 250,
        runCount: 42,
        errorCount: 3,
      },
    };

    await storage.saveJob(original);
    const retrieved = await storage.getJob('integrity-1');

    expect(retrieved).toEqual(original);
  });

  // --------------------------------------------------------------------------
  // 13. Combined enabled + tags filter
  // --------------------------------------------------------------------------

  it('combines enabled and tags filters correctly', async () => {
    await storage.saveJob(makeJob({ id: 'combo-1', enabled: true, tags: ['vip'] }));
    await storage.saveJob(makeJob({ id: 'combo-2', enabled: false, tags: ['vip'] }));
    await storage.saveJob(makeJob({ id: 'combo-3', enabled: true, tags: ['normal'] }));

    const result = await storage.listJobs({ enabled: true, tags: ['vip'] });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('combo-1');
  });
});
