/**
 * @module job-executor.test
 * @description Tests for the job executor
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeJob, validateJobExecutability } from '../executor/job-executor.js';
import type { CronJob, CronServiceConfig } from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';
import type { IAgentRuntime, Action, Memory, Content } from '@elizaos/core';

// Helper to create a mock runtime
function createMockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    agentId: 'test-agent-id',
    useModel: vi.fn().mockResolvedValue('Model response'),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    actions: [],
    ...overrides,
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

// Helper to create a mock action
function createMockAction(name: string, handler?: Action['handler']): Action {
  return {
    name,
    description: `Mock action: ${name}`,
    similes: [],
    validate: vi.fn().mockResolvedValue(true),
    handler:
      handler ||
      vi.fn().mockImplementation(
        async (
          _runtime: IAgentRuntime,
          _message: Memory,
          _state: unknown,
          _options: unknown,
          callback?: (response: Content) => Promise<Memory[]>
        ) => {
          if (callback) {
            await callback({ text: 'Action completed' });
          }
          return { success: true };
        }
      ),
  };
}

describe('job-executor', () => {
  let runtime: IAgentRuntime;
  let config: CronServiceConfig;

  beforeEach(() => {
    runtime = createMockRuntime();
    config = { ...DEFAULT_CRON_CONFIG };
  });

  describe('validateJobExecutability', () => {
    it('returns null for valid prompt jobs', () => {
      const job = createMockJob({
        payload: { kind: 'prompt', text: 'Test' },
      });

      const result = validateJobExecutability(runtime, job);

      expect(result).toBeNull();
    });

    it('returns null for valid event jobs', () => {
      const job = createMockJob({
        payload: { kind: 'event', eventName: 'TEST_EVENT' },
      });

      const result = validateJobExecutability(runtime, job);

      expect(result).toBeNull();
    });

    it('returns error for action jobs when action not found', () => {
      const job = createMockJob({
        payload: { kind: 'action', actionName: 'MISSING_ACTION' },
      });

      const result = validateJobExecutability(runtime, job);

      expect(result).toContain('Action not found');
    });

    it('returns null for action jobs when action exists', () => {
      const action = createMockAction('TEST_ACTION');
      runtime = createMockRuntime({ actions: [action] });

      const job = createMockJob({
        payload: { kind: 'action', actionName: 'TEST_ACTION' },
      });

      const result = validateJobExecutability(runtime, job);

      expect(result).toBeNull();
    });

    it('handles case-insensitive action name matching', () => {
      const action = createMockAction('My_Action');
      runtime = createMockRuntime({ actions: [action] });

      const job = createMockJob({
        payload: { kind: 'action', actionName: 'my_action' },
      });

      const result = validateJobExecutability(runtime, job);

      expect(result).toBeNull();
    });
  });

  describe('executeJob', () => {
    describe('prompt payload', () => {
      it('executes prompt and returns result', async () => {
        const job = createMockJob({
          payload: { kind: 'prompt', text: 'Generate a report' },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.status).toBe('ok');
        expect(result.output).toBe('Model response');
        expect(runtime.useModel).toHaveBeenCalledWith(
          'TEXT_LARGE',
          expect.objectContaining({
            prompt: expect.stringContaining('Generate a report'),
          })
        );
      });

      it('includes job context in prompt', async () => {
        const job = createMockJob({
          name: 'Daily Report',
          description: 'Generates the daily report',
          payload: { kind: 'prompt', text: 'Generate report' },
        });

        await executeJob(runtime, job, config);

        expect(runtime.useModel).toHaveBeenCalledWith(
          'TEXT_LARGE',
          expect.objectContaining({
            prompt: expect.stringContaining('Daily Report'),
          })
        );
      });

      it('handles model errors gracefully', async () => {
        runtime = createMockRuntime({
          useModel: vi.fn().mockRejectedValue(new Error('Model unavailable')),
        });

        const job = createMockJob({
          payload: { kind: 'prompt', text: 'Test' },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.status).toBe('error');
        expect(result.error).toContain('Model unavailable');
      });
    });

    describe('action payload', () => {
      it('executes action and returns result', async () => {
        const action = createMockAction('SEND_EMAIL');
        runtime = createMockRuntime({ actions: [action] });

        const job = createMockJob({
          payload: {
            kind: 'action',
            actionName: 'SEND_EMAIL',
            params: { to: 'test@example.com' },
          },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.status).toBe('ok');
        expect(action.validate).toHaveBeenCalled();
        expect(action.handler).toHaveBeenCalled();
      });

      it('returns error when action not found', async () => {
        const job = createMockJob({
          payload: { kind: 'action', actionName: 'MISSING_ACTION' },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.status).toBe('error');
        expect(result.error).toContain('Action not found');
      });

      it('returns error when action validation fails', async () => {
        const action = createMockAction('RESTRICTED_ACTION');
        (action.validate as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        runtime = createMockRuntime({ actions: [action] });

        const job = createMockJob({
          payload: { kind: 'action', actionName: 'RESTRICTED_ACTION' },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.status).toBe('error');
        expect(result.error).toContain('validation failed');
      });
    });

    describe('event payload', () => {
      it('emits event and returns success', async () => {
        const job = createMockJob({
          payload: {
            kind: 'event',
            eventName: 'CUSTOM_EVENT',
            payload: { data: 123 },
          },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.status).toBe('ok');
        expect(runtime.emitEvent).toHaveBeenCalledWith(
          'CUSTOM_EVENT',
          expect.objectContaining({
            runtime,
            source: `cron:${job.id}`,
            data: 123,
          })
        );
      });

      it('includes job context in event payload', async () => {
        const job = createMockJob({
          id: 'my-job-id',
          name: 'My Job',
          payload: { kind: 'event', eventName: 'TEST_EVENT' },
        });

        await executeJob(runtime, job, config);

        expect(runtime.emitEvent).toHaveBeenCalledWith(
          'TEST_EVENT',
          expect.objectContaining({
            cronJob: {
              id: 'my-job-id',
              name: 'My Job',
            },
          })
        );
      });
    });

    describe('timing', () => {
      it('records execution duration', async () => {
        const job = createMockJob({
          payload: { kind: 'prompt', text: 'Test' },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.durationMs).toBeDefined();
        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      });
    });

    describe('timeout handling', () => {
      it('handles jobs that throw errors', async () => {
        // Create a job that throws an error
        runtime = createMockRuntime({
          useModel: vi.fn().mockRejectedValue(new Error('Simulated failure')),
        });

        const job = createMockJob({
          payload: { kind: 'prompt', text: 'Test' },
        });

        const result = await executeJob(runtime, job, config);

        expect(result.status).toBe('error');
        expect(result.error).toContain('Simulated failure');
      });
    });
  });
});
