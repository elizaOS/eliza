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
