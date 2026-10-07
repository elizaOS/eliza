/** Exercises malformed and valid dynamic segments through the production trigger route handler. */

import { describe, expect, test } from 'bun:test';
import type http from 'node:http';
import type { IAgentRuntime, Task, TriggerConfig } from '@elizaos/core';
import { handleTriggerRoutes, type TriggerRouteContext } from '../../src/trigger-routes';

function createHarness(
  method: string,
  pathname: string
): {
  calls: string[];
  context: TriggerRouteContext;
  response: { body?: unknown; status?: number };
} {
  const calls: string[] = [];
  const response: { body?: unknown; status?: number } = {};
  const req = {} as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const runtime = {
    createTask: async () => {
      calls.push('createTask');
      return 'created-task';
    },
    deleteTask: async () => {
      calls.push('deleteTask');
    },
    getTask: async () => {
      calls.push('getTask');
      return null;
    },
  } as unknown as IAgentRuntime;
  const context = {
    method,
    pathname,
    req,
    res,
    runtime,
    ownerEntityId: 'owner-local',
    resolvePromptDeliveryRoom: async () => 'owner-room',
    localOwnerEntityId: 'owner-local',
    readJsonBody: async () => {
      calls.push('readJsonBody');
      return {};
    },
    json: (_res: http.ServerResponse, body: unknown, status?: number) => {
      response.body = body;
      response.status = status;
    },
    error: (_res: http.ServerResponse, message: string, status: number) => {
      response.body = { error: message };
      response.status = status;
    },
    executeTriggerTask: async () => {
      calls.push('executeTriggerTask');
      return { status: 'success', taskDeleted: false };
    },
    getTriggerHealthSnapshot: async () => {
      calls.push('getTriggerHealthSnapshot');
      return {
        triggersEnabled: true,
        activeTriggers: 0,
        disabledTriggers: 0,
        totalExecutions: 0,
        totalFailures: 0,
        totalSkipped: 0,
      };
    },
    getTriggerLimit: () => 10,
    listTriggerTasks: async () => {
      calls.push('listTriggerTasks');
      return [];
    },
    readTriggerConfig: () => null,
    readTriggerRuns: () => [],
    taskToTriggerSummary: () => null,
    triggersFeatureEnabled: () => true,
    buildTriggerConfig: () => ({}) as TriggerConfig,
    buildTriggerMetadata: () => null,
    normalizeTriggerDraft: () => ({ error: 'unused' }),
    DISABLED_TRIGGER_INTERVAL_MS: 60_000,
    TRIGGER_TASK_NAME: 'trigger',
    TRIGGER_TASK_TAGS: ['trigger'],
  } as unknown as TriggerRouteContext;

  return { calls, context, response };
}

describe('trigger route path decoding', () => {
  test('rejects malformed trigger IDs and event kinds before downstream work', async () => {
    for (const { method, pathname, message } of [
      {
        method: 'GET',
        pathname: '/api/triggers/%/runs',
        message: 'Invalid trigger ID: malformed URL encoding',
      },
      {
        method: 'POST',
        pathname: '/api/triggers/%2/execute',
        message: 'Invalid trigger ID: malformed URL encoding',
      },
      {
        method: 'POST',
        pathname: '/api/triggers/events/%ZZ',
        message: 'Invalid event kind: malformed URL encoding',
      },
      {
        method: 'GET',
        pathname: '/api/triggers/%E0%A4',
        message: 'Invalid trigger ID: malformed URL encoding',
      },
    ]) {
      const { calls, context, response } = createHarness(method, pathname);

      await expect(handleTriggerRoutes(context)).resolves.toBe(true);

      expect(response).toEqual({ body: { error: message }, status: 400 });
      expect(calls).toEqual([]);
    }
  });

  test('preserves valid encoded trigger IDs and event kinds', async () => {
    const runs = createHarness('GET', '/api/triggers/trigger%2Dprod/runs');
    const task = { id: 'task-id' } as Task;
    runs.context.listTriggerTasks = async () => {
      runs.calls.push('listTriggerTasks');
      return [task];
    };
    runs.context.readTriggerConfig = () => ({ triggerId: 'trigger-prod' }) as TriggerConfig;

    await expect(handleTriggerRoutes(runs.context)).resolves.toBe(true);

    expect(runs.calls).toEqual(['listTriggerTasks']);
    expect(runs.response).toEqual({ body: { runs: [] }, status: undefined });

    const event = createHarness('POST', '/api/triggers/events/order%2Ecreated');

    await expect(handleTriggerRoutes(event.context)).resolves.toBe(true);

    expect(event.calls).toEqual(['readJsonBody', 'listTriggerTasks']);
    expect(event.response).toEqual({
      body: {
        ok: true,
        eventKind: 'order.created',
        matched: 0,
        results: [],
      },
      status: undefined,
    });
  });
});

describe('trigger route ownership', () => {
  test.each(['prompt', 'workflow'] as const)(
    'binds a new %s to its trusted delivery room despite spoofed fields',
    async (kind) => {
      const { context, response } = createHarness('POST', '/api/triggers');
      let saved: Task | undefined;
      context.readJsonBody = async () => ({
        kind,
        roomId: 'spoofed-room',
        workflowId: 'test-workflow',
        displayName: 'QA prompt',
        instructions: 'Return a short answer',
        triggerType: 'cron',
        cronExpression: '0 12 28 9 *',
        createdBy: 'owner-foreign',
        ownerEntityId: 'owner-foreign',
      });
      context.normalizeTriggerDraft = ({ input }) => ({ draft: input as never });
      context.buildTriggerConfig = ({ draft, triggerId }) =>
        ({ ...draft, triggerId }) as TriggerConfig;
      context.buildTriggerMetadata = ({ trigger }) => ({ trigger });
      context.taskToTriggerSummary = (task) =>
        ({ id: (task.metadata?.trigger as TriggerConfig | undefined)?.triggerId }) as never;
      context.runtime = {
        createTask: async (task: Task) => {
          saved = { ...task, id: 'stored-task' };
          return 'stored-task';
        },
        getTask: async () => saved,
        getRoom: async () => ({ source: 'client_chat' }),
        getService: () => ({ getAutonomousRoomId: () => 'autonomy-room' }),
      } as unknown as IAgentRuntime;

      await handleTriggerRoutes(context);
      expect(response.status).toBe(201);
      if (!saved) throw new Error('Task was not saved');
      expect(saved.entityId).toBe('owner-local');
      expect(saved.roomId).toBe(kind === 'prompt' ? 'owner-room' : 'autonomy-room');
      expect((saved.metadata?.ownership as { ownerId: string } | undefined)?.ownerId).toBe(
        'owner-local'
      );
      expect((saved.metadata?.trigger as TriggerConfig | undefined)?.createdBy).toBe(
        'owner-foreign'
      );
    }
  );

  test('lists a legacy prompt for the canonical owner and hides an explicitly foreign task', async () => {
    const { context, response } = createHarness('GET', '/api/triggers');
    const legacy = { id: 'legacy', metadata: { trigger: { createdBy: 'api' } } } as Task;
    const foreign = {
      id: 'foreign',
      entityId: 'owner-foreign',
      metadata: { trigger: { createdBy: 'api' } },
    } as Task;
    context.listTriggerTasks = async () => [legacy, foreign];
    context.taskToTriggerSummary = (task) => ({ id: task.id }) as never;

    await handleTriggerRoutes(context);
    expect(response.body).toEqual({ triggers: [{ id: 'legacy' }] });
  });

  test('does not disclose or mutate a foreign trigger by ID', async () => {
    const foreign = {
      id: 'foreign-task',
      entityId: 'owner-foreign',
      metadata: { trigger: { triggerId: 'foreign-trigger', createdBy: 'api' } },
    } as Task;
    for (const [method, path] of [
      ['GET', '/api/triggers/foreign-trigger'],
      ['GET', '/api/triggers/foreign-trigger/runs'],
      ['PUT', '/api/triggers/foreign-trigger'],
      ['DELETE', '/api/triggers/foreign-trigger'],
      ['POST', '/api/triggers/foreign-trigger/execute'],
    ]) {
      const { context, response, calls } = createHarness(method, path);
      context.listTriggerTasks = async () => [foreign];
      context.readTriggerConfig = () => foreign.metadata?.trigger as TriggerConfig;
      await handleTriggerRoutes(context);
      expect(response).toEqual({ body: { error: 'Trigger not found' }, status: 404 });
      expect(calls).not.toContain('executeTriggerTask');
      expect(calls).not.toContain('deleteTask');
    }
  });

  test('rejects an untrusted requester even when the task is ownerless', async () => {
    const { context, response } = createHarness('GET', '/api/triggers');
    context.ownerEntityId = undefined;
    await handleTriggerRoutes(context);
    expect(response).toEqual({ body: { error: 'Owner role required' }, status: 403 });
  });

  test('event HTTP dispatch does not execute a foreign trigger', async () => {
    const { context, response, calls } = createHarness(
      'POST',
      '/api/triggers/events/order.created'
    );
    context.listTriggerTasks = async () => [
      {
        id: 'foreign-task',
        entityId: 'owner-foreign',
        metadata: { trigger: { createdBy: 'api' } },
      } as Task,
    ];
    context.readTriggerConfig = () =>
      ({ triggerType: 'event', enabled: true, eventKind: 'order.created' }) as TriggerConfig;
    await handleTriggerRoutes(context);
    expect(response.body).toEqual({
      ok: true,
      eventKind: 'order.created',
      matched: 0,
      results: [],
    });
    expect(calls).not.toContain('executeTriggerTask');
  });

  test.each(['agent-id', undefined, null])(
    'keeps heartbeat entity %s read-only',
    async (entityId) => {
      const heartbeat = {
        id: 'system-heartbeat',
        agentId: 'agent-id',
        entityId,
        tags: ['queue', 'repeat', 'heartbeat'],
        metadata: { updateInterval: 60_000 },
      } as Task;
      for (const [method, path, expectedStatus] of [
        ['GET', '/api/triggers/system-heartbeat', 200],
        ['PUT', '/api/triggers/system-heartbeat', 403],
        ['DELETE', '/api/triggers/system-heartbeat', 403],
        ['POST', '/api/triggers/system-heartbeat/execute', 403],
      ] as const) {
        const { context, response, calls } = createHarness(method, path);
        context.runtime = {
          agentId: 'agent-id',
          deleteTask: async () => calls.push('deleteTask'),
        } as unknown as IAgentRuntime;
        context.listTriggerTasks = async () => [heartbeat];
        context.taskToTriggerSummary = () => ({ id: 'system-heartbeat' }) as never;
        await handleTriggerRoutes(context);
        expect(response.status ?? 200).toBe(expectedStatus);
        if (expectedStatus === 403) {
          expect(response.body).toEqual({ error: 'System trigger is read-only' });
        }
        expect(calls).not.toContain('deleteTask');
        expect(calls).not.toContain('executeTriggerTask');
      }
    }
  );
});

describe('partial trigger updates', () => {
  test('retains the saved timezone unless the update supplies another one', async () => {
    for (const body of [
      { enabled: false },
      { displayName: 'Renamed prompt' },
      { enabled: false, timezone: 'Europe/London' },
    ]) {
      const { context, response } = createHarness('PUT', '/api/triggers/saved-prompt');
      const current = {
        triggerId: 'saved-prompt',
        kind: 'prompt',
        displayName: 'Saved prompt',
        instructions: 'Return a short answer',
        triggerType: 'cron',
        cronExpression: '0 9 * * *',
        enabled: true,
        timezone: 'America/Los_Angeles',
        createdBy: 'api',
      } as TriggerConfig;
      const task = { id: 'saved-task', metadata: { trigger: current } } as Task;
      context.listTriggerTasks = async () => [task];
      context.readTriggerConfig = () => current;
      context.readJsonBody = async () => body as never;
      let inputTimezone: string | undefined;
      context.normalizeTriggerDraft = ({ input }) => {
        inputTimezone = input.timezone;
        return { error: 'Stop before storage for this normalization assertion' };
      };

      await expect(handleTriggerRoutes(context)).resolves.toBe(true);

      expect(inputTimezone).toBe('timezone' in body ? body.timezone : 'America/Los_Angeles');
      expect(response.status).toBe(400);
    }
  });
});

describe('trigger enabled boundary', () => {
  test.each(['POST', 'PUT'] as const)(
    'rejects non-boolean enabled on %s before normalization',
    async (method) => {
      for (const enabled of ['false', 0, null, {}]) {
        const { context, response, calls } = createHarness(
          method,
          method === 'POST' ? '/api/triggers' : '/api/triggers/saved'
        );
        const current = {
          triggerId: 'saved',
          kind: 'prompt',
          createdBy: 'api',
          enabled: true,
        } as TriggerConfig;
        context.listTriggerTasks = async () => [
          { id: 'stored', metadata: { trigger: current } } as Task,
        ];
        context.readTriggerConfig = () => current;
        context.readJsonBody = async () => ({ enabled }) as never;
        context.normalizeTriggerDraft = () => {
          throw new Error('Invalid enabled reached normalization');
        };
        await handleTriggerRoutes(context);
        expect(response).toEqual({ body: { error: 'enabled must be a boolean' }, status: 400 });
        expect(calls).not.toContain('createTask');
      }
    }
  );

  test.each(['POST', 'PUT'] as const)('preserves boolean enabled on %s', async (method) => {
    for (const enabled of [false, true]) {
      const { context } = createHarness(
        method,
        method === 'POST' ? '/api/triggers' : '/api/triggers/saved'
      );
      const current = {
        triggerId: 'saved',
        kind: 'prompt',
        createdBy: 'api',
        enabled: true,
      } as TriggerConfig;
      context.listTriggerTasks = async () => [
        { id: 'stored', metadata: { trigger: current } } as Task,
      ];
      context.readTriggerConfig = () => current;
      context.readJsonBody = async () =>
        ({ kind: 'prompt', instructions: 'Return an answer', enabled }) as never;
      let normalized: boolean | undefined;
      context.normalizeTriggerDraft = ({ input }) => {
        normalized = input.enabled;
        return { error: 'Stop before storage' };
      };
      await handleTriggerRoutes(context);
      expect(normalized).toBe(enabled);
    }
  });

  test('refuses a prompt when the host delivery room has no source', async () => {
    const { context, response, calls } = createHarness('POST', '/api/triggers');
    context.readJsonBody = async () =>
      ({
        kind: 'prompt',
        instructions: 'Return an answer',
        displayName: 'Prompt',
        triggerType: 'cron',
        cronExpression: '0 12 * * *',
      }) as never;
    context.normalizeTriggerDraft = ({ input }) => ({ draft: input as never });
    context.buildTriggerConfig = ({ draft, triggerId }) =>
      ({ ...draft, triggerId }) as TriggerConfig;
    context.runtime.getRoom = async () => null;
    await handleTriggerRoutes(context);
    expect(response).toEqual({
      body: { error: 'Prompt automation delivery conversation is unavailable' },
      status: 503,
    });
    expect(calls).not.toContain('createTask');
  });
});
