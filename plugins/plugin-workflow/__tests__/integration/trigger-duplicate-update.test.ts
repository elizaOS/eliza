/**
 * Creation refuses a second trigger that is equivalent to an enabled one. This
 * drives the update route the same way: an edit that makes one trigger
 * equivalent to another enabled trigger must be refused too, otherwise both
 * dispatch the same workflow on the same schedule.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { createTestRuntime } from '@elizaos/testing/runtime';
import {
  executeTriggerTask,
  getTriggerHealthSnapshot,
  getTriggerLimit,
  listTriggerTasks,
  readTriggerConfig,
  readTriggerRuns,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from '../../../../packages/agent/src/triggers/runtime.ts';
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from '../../../../packages/agent/src/triggers/scheduling.ts';
import { handleTriggerRoutes, type TriggerRouteContext } from '../../src/trigger-routes';

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const ROOM = '00000000-0000-4000-8000-0000000000bb';
const WORKFLOW_ID = '00000000-0000-4000-8000-0000000000cc';

interface Captured {
  status: number;
  body: unknown;
}

async function callRoute(
  runtime: IAgentRuntime,
  method: string,
  pathname: string,
  body?: Record<string, unknown>
): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined };
  const context = {
    req: {},
    res: {},
    method,
    pathname,
    runtime,
    ownerEntityId: OWNER,
    localOwnerEntityId: OWNER,
    resolvePromptDeliveryRoom: async () => ROOM,
    readJsonBody: async () => body ?? null,
    json: (_res: unknown, data: unknown, status = 200) => {
      captured.status = status;
      captured.body = data;
    },
    error: (_res: unknown, message: string, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    executeTriggerTask,
    getTriggerHealthSnapshot,
    getTriggerLimit,
    listTriggerTasks,
    readTriggerConfig,
    readTriggerRuns,
    taskToTriggerSummary,
    triggersFeatureEnabled,
    buildTriggerConfig,
    buildTriggerMetadata,
    normalizeTriggerDraft,
    DISABLED_TRIGGER_INTERVAL_MS,
    TRIGGER_TASK_NAME,
    TRIGGER_TASK_TAGS,
  } as unknown as TriggerRouteContext;
  await handleTriggerRoutes(context);
  return captured;
}

function triggerIdOf(captured: Captured): string {
  const body = captured.body as { trigger?: { id?: string } } | undefined;
  const id = body?.trigger?.id;
  if (!id) throw new Error(`No trigger id in ${JSON.stringify(captured.body)}`);
  return id;
}

describe('trigger update keeps schedules distinct', () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;

  beforeAll(async () => {
    harness = await createTestRuntime({ characterName: 'TriggerRoutes' });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 60_000);

  test('an update that matches another enabled trigger is refused', async () => {
    const runtime = harness.runtime;
    const nine = await callRoute(runtime, 'POST', '/api/triggers', {
      kind: 'workflow',
      triggerType: 'cron',
      workflowId: WORKFLOW_ID,
      workflowName: 'Nightly',
      instructions: 'Run the nightly workflow',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
    });
    expect(nine.status).toBe(201);

    const ten = await callRoute(runtime, 'POST', '/api/triggers', {
      kind: 'workflow',
      triggerType: 'cron',
      workflowId: WORKFLOW_ID,
      workflowName: 'Nightly',
      instructions: 'Run the nightly workflow',
      cronExpression: '0 10 * * *',
      timezone: 'UTC',
    });
    expect(ten.status).toBe(201);

    // Creation already refuses this equivalence.
    const duplicate = await callRoute(runtime, 'POST', '/api/triggers', {
      kind: 'workflow',
      triggerType: 'cron',
      workflowId: WORKFLOW_ID,
      workflowName: 'Nightly',
      instructions: 'Run the nightly workflow',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
    });
    expect(duplicate.status).toBe(409);

    const moved = await callRoute(runtime, 'PUT', `/api/triggers/${triggerIdOf(ten)}`, {
      cronExpression: '0 9 * * *',
    });
    expect(moved.status).toBe(409);

    const tasks = await listTriggerTasks(runtime);
    const nineOClock = tasks.filter(
      (task) => readTriggerConfig(task)?.cronExpression === '0 9 * * *'
    );
    expect(nineOClock).toHaveLength(1);

    // A distinct schedule and a rename of a unique trigger still update.
    const backToTen = await callRoute(runtime, 'PUT', `/api/triggers/${triggerIdOf(ten)}`, {
      cronExpression: '0 10 * * *',
    });
    expect(backToTen.status).toBe(200);
    const renamed = await callRoute(runtime, 'PUT', `/api/triggers/${triggerIdOf(ten)}`, {
      displayName: 'Late nightly',
    });
    expect(renamed.status).toBe(200);

    // Enabling a paused trigger that matches an enabled one is refused, and the
    // refused update writes nothing.
    const paused = await callRoute(runtime, 'POST', '/api/triggers', {
      kind: 'workflow',
      triggerType: 'cron',
      workflowId: WORKFLOW_ID,
      workflowName: 'Nightly',
      instructions: 'Run the nightly workflow',
      cronExpression: '0 11 * * *',
      timezone: 'UTC',
    });
    expect(paused.status).toBe(201);
    const pausedId = triggerIdOf(paused);
    const pausedOnSameSchedule = await callRoute(runtime, 'PUT', `/api/triggers/${pausedId}`, {
      enabled: false,
      cronExpression: '0 9 * * *',
    });
    expect(pausedOnSameSchedule.status).toBe(200);
    const resumed = await callRoute(runtime, 'PUT', `/api/triggers/${pausedId}`, {
      enabled: true,
    });
    expect(resumed.status).toBe(409);
    const afterRefusal = (await listTriggerTasks(runtime)).find(
      (task) => readTriggerConfig(task)?.triggerId === pausedId
    );
    const pausedTrigger = afterRefusal ? readTriggerConfig(afterRefusal) : null;
    expect(pausedTrigger?.enabled).toBe(false);
    expect(pausedTrigger?.cronExpression).toBe('0 9 * * *');
  }, 120_000);
});
