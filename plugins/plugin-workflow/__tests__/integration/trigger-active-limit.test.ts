/**
 * The active-trigger cap (`ELIZA_TRIGGERS_MAX_ACTIVE`) is a write-boundary
 * invariant: POST /api/triggers answers 429 once the owner already holds that
 * many enabled triggers. Enabling a saved trigger is the same state change, so
 * PUT /api/triggers/:id must apply the same cap. Otherwise an owner at the cap
 * disables triggers, creates replacements, and re-enables the old ones to hold
 * an unbounded number of active automations.
 */
import { expect, test } from 'bun:test';
import type { Task, TriggerConfig } from '@elizaos/core';
import { handleTriggerRoutes, type TriggerRouteContext } from '../../src/trigger-routes';

const agentId = '00000000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-0000000000aa';
const DISABLED_INTERVAL_MS = 60 * 60 * 1000;

type RouteResult = { status: number; body: Record<string, unknown> };

function triggerTask(triggerId: string, enabled: boolean): Task {
  return {
    id: `00000000-0000-4000-8000-0000000000${triggerId.slice(-2)}`,
    name: 'TRIGGER_DISPATCH',
    agentId,
    entityId: owner,
    tags: ['queue', 'repeat', 'trigger'],
    metadata: {
      ownership: { ownerId: owner },
      updateInterval: 60_000,
      trigger: {
        schemaVersion: 1,
        triggerId,
        displayName: `Saved ${triggerId}`,
        instructions: `Run workflow ${triggerId}`,
        triggerType: 'interval',
        intervalMs: 60_000,
        enabled,
        wakeMode: 'inject_now',
        createdBy: 'api',
        dedupeKey: `dedupe-${triggerId}`,
        kind: 'workflow',
        workflowId: `wf-${triggerId}`,
        workflowName: `Workflow ${triggerId}`,
      },
    },
  } as unknown as Task;
}

function runtime(tasks: Task[], limit: number): TriggerRouteContext['runtime'] {
  return {
    agentId,
    character: { name: 'Eliza' },
    getSetting: () => undefined,
    getTask: async (id: string) => tasks.find((task) => task.id === id) ?? null,
    updateTask: async (id: string, patch: { metadata?: unknown; description?: string }) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`missing task ${id}`);
      if (patch.metadata) task.metadata = patch.metadata as Task['metadata'];
      if (patch.description) task.description = patch.description;
    },
    getTriggerLimit: () => limit,
    reportError: () => {},
  } as unknown as TriggerRouteContext['runtime'];
}

function context(
  routeRuntime: TriggerRouteContext['runtime'],
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
  tasks: Task[],
  limit: number
): { ctx: TriggerRouteContext; result: RouteResult } {
  const result: RouteResult = { status: 0, body: {} };
  const send = (status: number, payload: unknown) => {
    result.status = status;
    result.body = payload as Record<string, unknown>;
  };
  const ctx: TriggerRouteContext = {
    method,
    pathname,
    req: {} as TriggerRouteContext['req'],
    res: {} as TriggerRouteContext['res'],
    runtime: routeRuntime,
    ownerEntityId: owner,
    localOwnerEntityId: owner,
    readJsonBody: async () => body as never,
    json: (_res, payload, status = 200) => send(status, payload),
    error: (_res, message, status) => send(status ?? 500, { error: message }),
    resolvePromptDeliveryRoom: async () => owner as never,
    executeTriggerTask: async () => {
      throw new Error('Execution must not run in a scheduling test');
    },
    getTriggerHealthSnapshot: async () => ({}) as never,
    getTriggerLimit: () => limit,
    listTriggerTasks: async () => tasks,
    readTriggerConfig: (task) => (task.metadata?.trigger as TriggerConfig | null) ?? null,
    readTriggerRuns: () => [],
    taskToTriggerSummary: (task) => ({ ...(task.metadata?.trigger ?? {}) }) as never,
    triggersFeatureEnabled: () => true,
    buildTriggerConfig: ({ draft, triggerId }) =>
      ({ ...draft, triggerId, dedupeKey: `dedupe-${triggerId}` }) as never,
    buildTriggerMetadata: ({ trigger, nowMs }) =>
      ({
        updatedAt: nowMs,
        updateInterval: 60_000,
        trigger: { ...trigger, nextRunAtMs: nowMs + 60_000 },
      }) as never,
    normalizeTriggerDraft: ({ input, fallback }) =>
      ({
        draft: {
          displayName: input.displayName ?? fallback.displayName,
          instructions: input.instructions ?? fallback.instructions,
          triggerType: input.triggerType ?? fallback.triggerType,
          wakeMode: input.wakeMode ?? fallback.wakeMode,
          enabled: input.enabled ?? fallback.enabled,
          createdBy: input.createdBy ?? fallback.createdBy,
          intervalMs: input.intervalMs,
          kind: input.kind ?? 'workflow',
          workflowId: input.workflowId,
          workflowName: input.workflowName,
        },
      }) as never,
    DISABLED_TRIGGER_INTERVAL_MS: DISABLED_INTERVAL_MS,
    TRIGGER_TASK_NAME: 'TRIGGER_DISPATCH',
    TRIGGER_TASK_TAGS: ['queue', 'repeat', 'trigger'],
  };
  return { ctx, result };
}

test('POST refuses a new trigger once the owner holds the active-trigger cap', async () => {
  const tasks = [triggerTask('trig-01', true)];
  const routeRuntime = runtime(tasks, 1);
  const { ctx, result } = context(
    routeRuntime,
    'POST',
    '/api/triggers',
    {
      displayName: 'Second interval',
      triggerType: 'interval',
      intervalMs: 60_000,
      kind: 'workflow',
      workflowId: 'wf-2',
    },
    tasks,
    1
  );
  expect(await handleTriggerRoutes(ctx)).toBe(true);
  expect(result.status).toBe(429);
  expect(tasks).toHaveLength(1);
});

test('PUT refuses to enable a saved trigger past the active-trigger cap', async () => {
  const tasks = [triggerTask('trig-02', true), triggerTask('trig-03', false)];
  const routeRuntime = runtime(tasks, 1);
  const { ctx, result } = context(
    routeRuntime,
    'PUT',
    '/api/triggers/trig-03',
    { enabled: true },
    tasks,
    1
  );
  expect(await handleTriggerRoutes(ctx)).toBe(true);
  expect(result.status).toBe(429);
  expect(result.body.error).toBe('Active trigger limit reached (1)');
  expect(tasks[1].metadata?.trigger?.enabled).toBe(false);
});

test('PUT still enables a saved trigger while the owner has room under the cap', async () => {
  const tasks = [triggerTask('trig-04', true), triggerTask('trig-05', false)];
  const routeRuntime = runtime(tasks, 2);
  const { ctx, result } = context(
    routeRuntime,
    'PUT',
    '/api/triggers/trig-05',
    { enabled: true },
    tasks,
    2
  );
  expect(await handleTriggerRoutes(ctx)).toBe(true);
  expect(result.status).toBe(200);
  expect(tasks[1].metadata?.trigger?.enabled).toBe(true);
});
