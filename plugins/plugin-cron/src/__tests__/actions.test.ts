/**
 * @module actions.test
 * @description Tests for cron actions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCronAction } from '../actions/create-cron.js';
import { listCronsAction } from '../actions/list-crons.js';
import { updateCronAction } from '../actions/update-cron.js';
import { deleteCronAction } from '../actions/delete-cron.js';
import { runCronAction } from '../actions/run-cron.js';
import type { IAgentRuntime, Memory, Content, Service } from '@elizaos/core';
import type { CronJob } from '../types.js';
import { CRON_SERVICE_TYPE } from '../constants.js';

// Mock CronService
function createMockCronService() {
  const jobs = new Map<string, CronJob>();

  return {
    createJob: vi.fn().mockImplementation(async (input) => {
      const job: CronJob = {
        id: `job-${Date.now()}`,
        name: input.name,
        enabled: input.enabled,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        schedule: input.schedule,
        payload: input.payload,
        state: { runCount: 0, errorCount: 0 },
      };
      jobs.set(job.id, job);
      return job;
    }),
    updateJob: vi.fn().mockImplementation(async (jobId, patch) => {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      const updated = { ...job, ...patch, updatedAtMs: Date.now() };
      jobs.set(jobId, updated);
      return updated;
    }),
    deleteJob: vi.fn().mockImplementation(async (jobId) => {
      return jobs.delete(jobId);
    }),
    getJob: vi.fn().mockImplementation(async (jobId) => {
      return jobs.get(jobId) || null;
    }),
    listJobs: vi.fn().mockImplementation(async () => {
      return Array.from(jobs.values());
    }),
    runJob: vi.fn().mockImplementation(async (jobId) => {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      return { ran: true, status: 'ok', durationMs: 100 };
    }),
  };
}

// Mock runtime
function createMockRuntime(cronService: ReturnType<typeof createMockCronService>): IAgentRuntime {
  return {
    agentId: 'test-agent-id',
    getService: vi.fn().mockImplementation((type: string) => {
      if (type === CRON_SERVICE_TYPE) {
        return cronService as unknown as Service;
      }
      return null;
    }),
    getSetting: vi.fn().mockReturnValue(null),
    character: { name: 'TestAgent' },
  } as unknown as IAgentRuntime;
}

// Mock memory
function createMockMemory(text: string): Memory {
  return {
    id: 'test-memory-id',
    entityId: 'test-entity-id',
    roomId: 'test-room-id',
    agentId: 'test-agent-id',
    content: { text } as Content,
    createdAt: Date.now(),
  } as Memory;
}

describe('cron actions', () => {
  let cronService: ReturnType<typeof createMockCronService>;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    cronService = createMockCronService();
    runtime = createMockRuntime(cronService);
  });

  describe('createCronAction', () => {
    it('has correct metadata', () => {
      expect(createCronAction.name).toBe('CREATE_CRON');
      expect(createCronAction.description).toBeDefined();
      expect(createCronAction.similes).toContain('SCHEDULE_JOB');
    });

    it('validates messages about creating cron jobs', async () => {
      const memory = createMockMemory('create a cron job that runs every hour');
      const isValid = await createCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('validates messages about scheduling tasks', async () => {
      const memory = createMockMemory('schedule a task to check emails daily');
      const isValid = await createCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('rejects unrelated messages', async () => {
      const memory = createMockMemory('what is the weather today');
      const isValid = await createCronAction.validate(runtime, memory);
      expect(isValid).toBe(false);
    });

    it('calls handler without error', async () => {
      const memory = createMockMemory(
        'Create a cron job called "Hourly Report" that runs every hour and prompts "Generate status report"'
      );
      const responses: Content[] = [];
      const callback = async (response: Content) => {
        responses.push(response);
        return [];
      };

      // Handler should complete without throwing
      await expect(
        createCronAction.handler(runtime, memory, undefined, undefined, callback)
      ).resolves.not.toThrow();

      // Should produce some response
      expect(responses.length).toBeGreaterThan(0);
    });
  });

  describe('listCronsAction', () => {
    it('has correct metadata', () => {
      expect(listCronsAction.name).toBe('LIST_CRONS');
      expect(listCronsAction.description).toBeDefined();
      expect(listCronsAction.similes).toContain('SHOW_CRONS');
    });

    it('validates messages about listing cron jobs', async () => {
      const memory = createMockMemory('list all cron jobs');
      const isValid = await listCronsAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('validates messages about showing scheduled tasks', async () => {
      const memory = createMockMemory('show my scheduled tasks');
      const isValid = await listCronsAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('lists jobs when handler is called', async () => {
      // Create some jobs first
      await cronService.createJob({
        name: 'Test Job 1',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        payload: { kind: 'prompt', text: 'Test' },
      });

      const memory = createMockMemory('list all cron jobs');
      const responses: Content[] = [];
      const callback = async (response: Content) => {
        responses.push(response);
        return [];
      };

      await listCronsAction.handler(runtime, memory, undefined, undefined, callback);

      expect(cronService.listJobs).toHaveBeenCalled();
      expect(responses.length).toBeGreaterThan(0);
      // Response should contain job information
      expect(responses[0].text).toBeDefined();
    });
  });

  describe('updateCronAction', () => {
    it('has correct metadata', () => {
      expect(updateCronAction.name).toBe('UPDATE_CRON');
      expect(updateCronAction.description).toBeDefined();
      expect(updateCronAction.similes).toContain('MODIFY_CRON');
    });

    it('validates messages about updating cron jobs', async () => {
      const memory = createMockMemory('update the hourly report cron');
      const isValid = await updateCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('validates messages about disabling jobs', async () => {
      const memory = createMockMemory('disable the daily backup job');
      const isValid = await updateCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('updates a job when handler is called', async () => {
      // Create a job first
      const job = await cronService.createJob({
        name: 'Test Job',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        payload: { kind: 'prompt', text: 'Test' },
      });

      const memory = createMockMemory(`disable job ${job.id}`);
      const responses: Content[] = [];
      const callback = async (response: Content) => {
        responses.push(response);
        return [];
      };

      await updateCronAction.handler(runtime, memory, undefined, undefined, callback);

      expect(responses.length).toBeGreaterThan(0);
    });
  });

  describe('deleteCronAction', () => {
    it('has correct metadata', () => {
      expect(deleteCronAction.name).toBe('DELETE_CRON');
      expect(deleteCronAction.description).toBeDefined();
      expect(deleteCronAction.similes).toContain('REMOVE_CRON');
    });

    it('validates messages about deleting cron jobs', async () => {
      const memory = createMockMemory('delete the test cron job');
      const isValid = await deleteCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('validates messages about removing cron jobs', async () => {
      const memory = createMockMemory('remove the backup cron job');
      const isValid = await deleteCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('handles delete request via handler', async () => {
      // Create a job first
      const job = await cronService.createJob({
        name: 'Job To Delete',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        payload: { kind: 'prompt', text: 'Test' },
      });

      const memory = createMockMemory(`delete the cron job named Job To Delete`);
      const responses: Content[] = [];
      const callback = async (response: Content) => {
        responses.push(response);
        return [];
      };

      // Handler should complete without throwing
      await expect(
        deleteCronAction.handler(runtime, memory, undefined, undefined, callback)
      ).resolves.not.toThrow();

      expect(responses.length).toBeGreaterThan(0);
    });
  });

  describe('runCronAction', () => {
    it('has correct metadata', () => {
      expect(runCronAction.name).toBe('RUN_CRON');
      expect(runCronAction.description).toBeDefined();
      expect(runCronAction.similes).toContain('EXECUTE_CRON');
    });

    it('validates messages about running cron jobs', async () => {
      const memory = createMockMemory('run the daily report job now');
      const isValid = await runCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('validates messages about triggering jobs', async () => {
      const memory = createMockMemory('trigger the backup job');
      const isValid = await runCronAction.validate(runtime, memory);
      expect(isValid).toBe(true);
    });

    it('handles run request via handler', async () => {
      // Create a job first
      const job = await cronService.createJob({
        name: 'Runnable Job',
        enabled: true,
        schedule: { kind: 'every', everyMs: 60000 },
        payload: { kind: 'prompt', text: 'Test' },
      });

      const memory = createMockMemory(`run the Runnable Job cron now`);
      const responses: Content[] = [];
      const callback = async (response: Content) => {
        responses.push(response);
        return [];
      };

      // Handler should complete without throwing
      await expect(
        runCronAction.handler(runtime, memory, undefined, undefined, callback)
      ).resolves.not.toThrow();

      expect(responses.length).toBeGreaterThan(0);
    });
  });
});
