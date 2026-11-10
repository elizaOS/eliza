import { expect, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import {
  __resetAutomationsCacheForTests,
  buildAutomationListResponse,
} from '../../src/lib/automations-builder';
import { WORKFLOW_SERVICE_TYPE } from '../../src/services/workflow-service';
import { handleTriggerRoutes } from '../../src/trigger-routes';

const agentId = '00000000-0000-4000-8000-000000000001';
const owner = '00000000-0000-4000-8000-0000000000aa';
const triggerTask = {
  id: '00000000-0000-4000-8000-0000000000b1',
  name: 'TRIGGER_DISPATCH_X',
  agentId,
  entityId: owner,
  tags: ['queue', 'repeat', 'trigger'],
  metadata: {
    ownership: { ownerId: owner },
    updatedAt: 1,
    trigger: {
      triggerId: 'trig-1',
      displayName: 'Nightly report',
      instructions: 'Run workflow Nightly',
      triggerType: 'cron',
      cronExpression: '0 2 * * *',
      enabled: true,
      wakeMode: 'inject_now',
      createdBy: 'api',
      kind: 'workflow',
      workflowId: 'wf-1',
      workflowName: 'Nightly',
    },
  },
};

function runtime(
  listWorkflows: () => Promise<unknown[]>,
  listExecutions: () => Promise<{ data: unknown[] }> = async () => ({ data: [] })
): IAgentRuntime {
  const service = { listWorkflows, listExecutions };
  return {
    agentId,
    character: { name: 'Eliza' },
    getSetting: () => undefined,
    getRoomsForParticipant: async () => [],
    getRoomsByIds: async () => [],
    getTasks: async (query: { tags?: string[] }) =>
      !query.tags || query.tags.includes('trigger') ? [triggerTask] : [],
    getService: (type: string) => (type === WORKFLOW_SERVICE_TYPE ? service : null),
    reportError: () => {},
  } as unknown as IAgentRuntime;
}

const summary = (response: Awaited<ReturnType<typeof buildAutomationListResponse>>) =>
  response.automations.map((item) => ({
    id: item.id,
    status: item.status,
    schedules: item.schedules.map((schedule) => schedule.id),
  }));

test('keeps a scheduled workflow trigger in the feed when the workflow list fails', async () => {
  const online = await buildAutomationListResponse(
    runtime(async () => [
      { id: 'wf-1', name: 'Nightly', active: true, nodes: [], connections: {} },
    ]),
    owner
  );
  const offline = await buildAutomationListResponse(
    runtime(async () => {
      throw new Error('db down');
    }),
    owner
  );

  expect(summary(online)).toEqual([
    { id: 'workflow:wf-1', status: 'active', schedules: ['trig-1'] },
  ]);
  expect(offline.workflowFetchError).not.toBeNull();
  expect(summary(offline)).toEqual(summary(online));
});

test('hides a trigger whose workflow is missing from a successful list', async () => {
  const response = await buildAutomationListResponse(
    runtime(async () => []),
    owner
  );
  expect(response.automations).toEqual([]);
});

test('the feed shows a run that finished 1 s after the previous feed read', async () => {
  __resetAutomationsCacheForTests();
  const run = {
    id: 'exec-1',
    workflowId: 'wf-1',
    status: 'running',
    finished: false,
    startedAt: '2026-11-08T07:00:00.000Z',
    stoppedAt: null,
  };
  const live = runtime(
    async () => [{ id: 'wf-1', name: 'Nightly', active: true }],
    async () => ({ data: [{ ...run }] })
  );
  const lastExecution = async () =>
    (await buildAutomationListResponse(live, owner)).automations[0]?.lastExecution;

  expect(await lastExecution()).toMatchObject({ status: 'running' });
  Object.assign(run, {
    status: 'finished',
    finished: true,
    stoppedAt: '2026-11-08T07:00:01.000Z',
  });
  expect(await lastExecution()).toMatchObject({
    status: 'success',
    stoppedAt: '2026-11-08T07:00:01.000Z',
  });
});

const workflowSchedule = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: 'TRIGGER_DISPATCH',
  agentId,
  entityId: owner,
  tags: ['queue', 'repeat', 'trigger'],
  metadata: {
    reviewedVersionId: 'version-1',
    trigger: {
      ...triggerTask.metadata.trigger,
      triggerId: 'trig-schedule',
      dedupeKey: 'workflow-schedule:wf-1',
    },
  },
};

function triggerRoute(tasks: Array<Record<string, unknown>>) {
  const store = new Map(tasks.map((task) => [task.id as string, structuredClone(task)]));
  const responses: Array<{ status: number; body: unknown }> = [];
  const deleted: string[] = [];
  const route = (method: string, id: string, body?: Record<string, unknown>) =>
    handleTriggerRoutes({
      req: {} as never,
      res: {} as never,
      method,
      pathname: `/api/triggers/${id}`,
      runtime: {
        agentId,
        getTask: async (taskId: string) => store.get(taskId) ?? null,
        updateTask: async (taskId: string, update: Record<string, unknown>) => {
          store.set(taskId, { ...store.get(taskId), ...update });
        },
        deleteTask: async (taskId: string) => {
          deleted.push(taskId);
          store.delete(taskId);
        },
      } as unknown as IAgentRuntime,
      assertCurrentRuntime: () => {},
      ownerEntityId: owner,
      localOwnerEntityId: owner,
      readJsonBody: async () => body ?? {},
      json: (_res: unknown, value: unknown, status = 200) => {
        responses.push({ status, body: value });
      },
      error: (_res: unknown, message: string, status = 500) => {
        responses.push({ status, body: { error: message } });
      },
      triggersFeatureEnabled: () => true,
      listTriggerTasks: async () => [...store.values()],
      readTriggerConfig: (task: { metadata?: { trigger?: unknown } }) =>
        task.metadata?.trigger ?? null,
      readTriggerRuns: () => [],
      taskToTriggerSummary: (task: { metadata?: { trigger?: unknown } }) =>
        task.metadata?.trigger ?? null,
      normalizeTriggerDraft: ({ input }: { input: Record<string, unknown> }) => ({
        draft: input,
      }),
      buildTriggerConfig: ({
        draft,
        previous,
        triggerId,
      }: {
        draft: Record<string, unknown>;
        previous?: Record<string, unknown>;
        triggerId: string;
      }) => ({ ...previous, ...draft, triggerId }),
      buildTriggerMetadata: ({
        existingMetadata,
        trigger,
      }: {
        existingMetadata?: Record<string, unknown>;
        trigger: Record<string, unknown>;
      }) => ({ ...existingMetadata, trigger }),
      getTriggerLimit: () => 100,
    } as unknown as Parameters<typeof handleTriggerRoutes>[0]);
  return { route, responses, deleted, store };
}

test('PUT and DELETE refuse a schedule the workflow owns', async () => {
  const { route, responses, deleted, store } = triggerRoute([workflowSchedule]);

  await route('PUT', 'trig-schedule', { displayName: 'Changed', cronExpression: '0 3 * * *' });
  await route('DELETE', 'trig-schedule');

  expect(responses).toEqual([
    {
      status: 403,
      body: { error: 'This schedule belongs to a workflow. Change it in the workflow.' },
    },
    {
      status: 403,
      body: { error: 'This schedule belongs to a workflow. Change it in the workflow.' },
    },
  ]);
  expect(deleted).toEqual([]);
  expect(store.get(workflowSchedule.id)).toEqual(workflowSchedule);
});

test('a user-created workflow trigger stays editable', async () => {
  const { route, responses, deleted } = triggerRoute([triggerTask]);

  await route('PUT', 'trig-1', { displayName: 'Nightly digest' });
  await route('DELETE', 'trig-1');

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(responses[0]?.body).toMatchObject({ trigger: { displayName: 'Nightly digest' } });
  expect(deleted).toEqual([triggerTask.id]);
});
