import { expect, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { buildAutomationListResponse } from '../../src/lib/automations-builder';
import { WORKFLOW_SERVICE_TYPE } from '../../src/services/workflow-service';

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

function runtime(listWorkflows: () => Promise<unknown[]>): IAgentRuntime {
  return {
    agentId,
    character: { name: 'Eliza' },
    getSetting: () => undefined,
    getRooms: async () => [],
    getTasks: async (query: { tags?: string[] }) =>
      !query.tags || query.tags.includes('trigger') ? [triggerTask] : [],
    getService: (type: string) =>
      type === WORKFLOW_SERVICE_TYPE
        ? { listWorkflows, listExecutions: async () => ({ data: [] }) }
        : null,
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
