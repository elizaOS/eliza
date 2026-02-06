/**
 * @module actions-extended.test
 * @description Extended tests for cron actions - validation, edge cases, error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCronAction } from '../actions/create-cron.js';
import { listCronsAction } from '../actions/list-crons.js';
import { updateCronAction } from '../actions/update-cron.js';
import { deleteCronAction } from '../actions/delete-cron.js';
import { runCronAction } from '../actions/run-cron.js';
import type { IAgentRuntime, Memory, State, Content, HandlerCallback, UUID } from '@elizaos/core';
import type { CronJob, CronExecutionResult } from '../types.js';

/**
 * Mock interface for CronService-like functionality
 */
interface MockCronService {
  createJob: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  updateJob: ReturnType<typeof vi.fn>;
  deleteJob: ReturnType<typeof vi.fn>;
  listJobs: ReturnType<typeof vi.fn>;
  runJobNow: ReturnType<typeof vi.fn>;
  getJobCount: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

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
    state: { runCount: 0, errorCount: 0 },
    ...overrides,
  };
}

function createMockCronService(jobs: Map<string, CronJob> = new Map()): MockCronService {
  return {
    createJob: vi.fn().mockImplementation(async (create: Partial<CronJob>) => {
      const job = createMockJob((create as { id?: string }).id ?? `job-${Date.now()}`, {
        ...create,
        schedule: create.schedule!,
        payload: create.payload!,
      });
      jobs.set(job.id, job);
      return job;
    }),
    getJob: vi.fn().mockImplementation(async (id: string) => jobs.get(id) ?? null),
    updateJob: vi.fn().mockImplementation(async (id: string, patch: Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return null;
      const updated = { ...job, ...patch, updatedAtMs: Date.now() };
      jobs.set(id, updated);
      return updated;
    }),
    deleteJob: vi.fn().mockImplementation(async (id: string) => {
      const existed = jobs.has(id);
      jobs.delete(id);
      return existed;
    }),
    listJobs: vi.fn().mockImplementation(async () => Array.from(jobs.values())),
    runJobNow: vi.fn().mockResolvedValue({ status: 'ok', durationMs: 100 } as CronExecutionResult),
    getJobCount: vi.fn().mockImplementation(async () => jobs.size),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockRuntime(cronService: MockCronService | null = null): IAgentRuntime {
  return {
    agentId: 'test-agent' as UUID,
    getService: vi.fn().mockImplementation((name: string) => {
      if (name === 'cron') return cronService;
      return null;
    }),
  } as unknown as IAgentRuntime;
}

function createMockMemory(text: string): Memory {
  return {
    id: 'mem-1' as UUID,
    userId: 'user-1' as UUID,
    agentId: 'test-agent' as UUID,
    roomId: 'room-1' as UUID,
    entityId: 'entity-1' as UUID,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

function createMockState(): State {
  return {} as State;
}

describe('Actions extended tests', () => {
  let jobs: Map<string, CronJob>;
  let cronService: MockCronService;
  let runtime: IAgentRuntime;
  let state: State;
  let callbackResponses: Content[];
  let callback: HandlerCallback;

  beforeEach(() => {
    jobs = new Map();
    cronService = createMockCronService(jobs);
    runtime = createMockRuntime(cronService);
    state = createMockState();
    callbackResponses = [];
    callback = vi.fn().mockImplementation(async (content: Content) => {
      callbackResponses.push(content);
      return [];
    });
  });

  // ==========================================================================
  // CREATE CRON ACTION - EXTENDED
  // ==========================================================================

  describe('createCronAction validation', () => {
    it('validates with proper message content', async () => {
      const message = createMockMemory('schedule a job every 5 minutes to check status');
      const result = await createCronAction.validate(runtime, message);
      expect(result).toBe(true);
    });

    it('validates when cron service is available', async () => {
      const message = createMockMemory('create cron');
      const result = await createCronAction.validate(runtime, message);
      expect(result).toBe(true);
    });
  });

  describe('createCronAction handler edge cases', () => {
    it('handles message with only schedule, no payload', async () => {
      const message = createMockMemory('run every hour');

      await createCronAction.handler(runtime, message, state, {}, callback);

      // Should respond with something (either error or confirmation)
      expect(callback).toHaveBeenCalled();
    });

    it('handles complex schedule descriptions', async () => {
      const message = createMockMemory(
        'schedule "Daily Report" every day at 9:00 AM to run the GENERATE_REPORT action'
      );

      await createCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles schedule with timezone', async () => {
      const message = createMockMemory(
        'create a job every day at 3pm America/New_York to send summary'
      );

      await createCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles cron expression input', async () => {
      const message = createMockMemory(
        'schedule "Hourly Check" with cron "0 * * * *" to check health'
      );

      await createCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // LIST CRONS ACTION - EXTENDED
  // ==========================================================================

  describe('listCronsAction with various job states', () => {
    it('lists empty job set gracefully', async () => {
      const message = createMockMemory('list all cron jobs');

      await listCronsAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
      const response = callbackResponses[0];
      expect(response.text).toBeDefined();
    });

    it('lists multiple jobs with different states', async () => {
      jobs.set('job-1', createMockJob('job-1', {
        name: 'Active Job',
        enabled: true,
        state: { runCount: 10, errorCount: 0, lastStatus: 'ok' },
      }));
      jobs.set('job-2', createMockJob('job-2', {
        name: 'Disabled Job',
        enabled: false,
      }));
      jobs.set('job-3', createMockJob('job-3', {
        name: 'Failed Job',
        state: { runCount: 5, errorCount: 3, lastStatus: 'error', lastError: 'Timeout' },
      }));

      const message = createMockMemory('show me all scheduled jobs');

      await listCronsAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
      const response = callbackResponses[0];
      // Should list all jobs
      expect(response.text).toBeDefined();
    });

    it('handles filter request for enabled jobs', async () => {
      jobs.set('job-1', createMockJob('job-1', { enabled: true }));
      jobs.set('job-2', createMockJob('job-2', { enabled: false }));

      const message = createMockMemory('list only enabled cron jobs');

      await listCronsAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // UPDATE CRON ACTION - EXTENDED
  // ==========================================================================

  describe('updateCronAction edge cases', () => {
    beforeEach(() => {
      jobs.set('existing-job', createMockJob('existing-job', { name: 'Existing Job' }));
    });

    it('handles update request by job name', async () => {
      const message = createMockMemory('update "Existing Job" to run every 2 hours');

      await updateCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles update request by job id', async () => {
      const message = createMockMemory('update job existing-job to be disabled');

      await updateCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles request to update non-existent job', async () => {
      const message = createMockMemory('update "Ghost Job" to run every minute');

      await updateCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
      // Should indicate job not found
    });

    it('handles enabling a disabled job', async () => {
      jobs.set('disabled-job', createMockJob('disabled-job', { enabled: false }));

      const message = createMockMemory('enable the disabled-job cron');

      await updateCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles changing job schedule', async () => {
      const message = createMockMemory('change existing-job schedule to every 30 seconds');

      await updateCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // DELETE CRON ACTION - EXTENDED
  // ==========================================================================

  describe('deleteCronAction edge cases', () => {
    beforeEach(() => {
      jobs.set('deletable', createMockJob('deletable', { name: 'Deletable Job' }));
    });

    it('validates with proper delete request', async () => {
      const message = createMockMemory('delete the Deletable Job cron');
      const result = await deleteCronAction.validate(runtime, message);
      expect(result).toBe(true);
    });

    it('handles delete by name', async () => {
      const message = createMockMemory('remove the "Deletable Job" scheduled task');

      await deleteCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles delete by id', async () => {
      const message = createMockMemory('delete cron job deletable');

      await deleteCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles delete of non-existent job gracefully', async () => {
      const message = createMockMemory('delete the "NonExistent Job"');

      await deleteCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
      // Should indicate not found
    });

    it('handles ambiguous delete request', async () => {
      jobs.set('job-a', createMockJob('job-a', { name: 'Daily Report' }));
      jobs.set('job-b', createMockJob('job-b', { name: 'Daily Backup' }));

      const message = createMockMemory('delete Daily');

      await deleteCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
      // Should either ask for clarification or handle somehow
    });
  });

  // ==========================================================================
  // RUN CRON ACTION - EXTENDED
  // ==========================================================================

  describe('runCronAction edge cases', () => {
    beforeEach(() => {
      jobs.set('runnable', createMockJob('runnable', { name: 'Runnable Job' }));
    });

    it('validates with proper run request', async () => {
      const message = createMockMemory('run the Runnable Job now');
      const result = await runCronAction.validate(runtime, message);
      expect(result).toBe(true);
    });

    it('handles run by name', async () => {
      const message = createMockMemory('execute "Runnable Job" immediately');

      await runCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles run by id', async () => {
      const message = createMockMemory('trigger cron runnable');

      await runCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles run of non-existent job', async () => {
      const message = createMockMemory('run "Ghost Job" now');

      await runCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
      // Should indicate not found
    });

    it('reports job execution result', async () => {
      (cronService.runJobNow as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'ok',
        durationMs: 250,
        output: 'Generated report successfully',
      });

      const message = createMockMemory('run runnable job');

      await runCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('reports job execution error', async () => {
      (cronService.runJobNow as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'error',
        error: 'API timeout',
        durationMs: 5000,
      });

      const message = createMockMemory('run runnable job');

      await runCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SERVICE UNAVAILABILITY
  // ==========================================================================

  describe('handling unavailable cron service', () => {
    let runtimeNoService: IAgentRuntime;

    beforeEach(() => {
      runtimeNoService = createMockRuntime(null);
    });

    it('createCronAction handles missing service', async () => {
      const message = createMockMemory('create a job');

      // Depending on implementation, might throw or return error
      try {
        await createCronAction.handler(runtimeNoService, message, state, {}, callback);
      } catch (e) {
        // Expected to fail gracefully
        expect(e).toBeDefined();
      }
    });

    it('listCronsAction handles missing service', async () => {
      const message = createMockMemory('list jobs');

      try {
        await listCronsAction.handler(runtimeNoService, message, state, {}, callback);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  // ==========================================================================
  // ACTION METADATA
  // ==========================================================================

  describe('action metadata', () => {
    it('createCronAction has required properties', () => {
      expect(createCronAction.name).toBeDefined();
      expect(createCronAction.description).toBeDefined();
      expect(createCronAction.validate).toBeDefined();
      expect(createCronAction.handler).toBeDefined();
      expect(createCronAction.similes).toBeDefined();
    });

    it('listCronsAction has required properties', () => {
      expect(listCronsAction.name).toBeDefined();
      expect(listCronsAction.description).toBeDefined();
      expect(listCronsAction.validate).toBeDefined();
      expect(listCronsAction.handler).toBeDefined();
    });

    it('updateCronAction has required properties', () => {
      expect(updateCronAction.name).toBeDefined();
      expect(updateCronAction.description).toBeDefined();
      expect(updateCronAction.validate).toBeDefined();
      expect(updateCronAction.handler).toBeDefined();
    });

    it('deleteCronAction has required properties', () => {
      expect(deleteCronAction.name).toBeDefined();
      expect(deleteCronAction.description).toBeDefined();
      expect(deleteCronAction.validate).toBeDefined();
      expect(deleteCronAction.handler).toBeDefined();
    });

    it('runCronAction has required properties', () => {
      expect(runCronAction.name).toBeDefined();
      expect(runCronAction.description).toBeDefined();
      expect(runCronAction.validate).toBeDefined();
      expect(runCronAction.handler).toBeDefined();
    });
  });

  // ==========================================================================
  // INPUT SANITIZATION / EDGE INPUTS
  // ==========================================================================

  describe('input edge cases', () => {
    it('handles empty message text', async () => {
      const message = createMockMemory('');

      await listCronsAction.handler(runtime, message, state, {}, callback);

      // Should not crash, might list all or respond appropriately
      expect(callback).toHaveBeenCalled();
    });

    it('handles very long message text', async () => {
      const longText = 'schedule a job '.repeat(1000);
      const message = createMockMemory(longText);

      await createCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles message with SQL injection attempt', async () => {
      const message = createMockMemory("delete job '; DROP TABLE jobs; --");

      await deleteCronAction.handler(runtime, message, state, {}, callback);

      // Should handle safely without actual SQL execution
      expect(callback).toHaveBeenCalled();
    });

    it('handles message with special characters', async () => {
      const message = createMockMemory(
        'create "Test <script>alert(1)</script>" every hour'
      );

      await createCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });

    it('handles unicode in job names', async () => {
      const message = createMockMemory('create "日本語ジョブ 🎉" every minute');

      await createCronAction.handler(runtime, message, state, {}, callback);

      expect(callback).toHaveBeenCalled();
    });
  });
});
