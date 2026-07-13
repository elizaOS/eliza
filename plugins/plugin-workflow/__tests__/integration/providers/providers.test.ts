/**
 * Exercises workflow providers through a real AgentRuntime, WorkflowService,
 * EmbeddedWorkflowService, runtime cache, and PGlite persistence. No internal
 * runtime or service boundary is mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Memory, type State, stringToUuid } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import { activeWorkflowsProvider } from '../../../src/providers/activeWorkflows';
import { pendingDraftProvider } from '../../../src/providers/pendingDraft';
import { workflowStatusProvider } from '../../../src/providers/workflowStatus';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../../src/services/workflow-service';
import type { WorkflowDefinition } from '../../../src/types';
import { type EmbeddedHarness, makeEmbeddedHarness } from '../embedded-harness';

const USER_ID = stringToUuid('workflow-provider-user');
const OTHER_USER_ID = stringToUuid('workflow-provider-other-user');

function message(text = 'Test message', entityId = USER_ID): Memory {
  return {
    id: stringToUuid(`workflow-provider-message:${text}:${entityId}`),
    entityId,
    agentId: stringToUuid('workflow-provider-agent'),
    roomId: stringToUuid('workflow-provider-room'),
    content: { text },
    createdAt: Date.now(),
  };
}

function state(): State {
  return { data: {}, values: {}, text: '' };
}

function workflowDefinition(name: string, integration = 'set'): WorkflowDefinition {
  const actionName = integration === 'slack' ? 'Slack' : 'Set';
  const actionType =
    integration === 'slack' ? 'workflows-nodes-base.httpRequest' : 'workflows-nodes-base.set';
  return {
    name,
    nodes: [
      {
        id: 'trigger',
        name: 'Manual Trigger',
        type: 'workflows-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'action',
        name: actionName,
        type: actionType,
        typeVersion: integration === 'slack' ? 2.2 : 3.4,
        position: [200, 0],
        parameters:
          integration === 'slack'
            ? { method: 'POST', url: 'https://slack.example.test/hooks/alerts' }
            : { assignments: { assignments: [] } },
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: actionName, type: 'main', index: 0 }]] },
    },
  };
}

async function registerWorkflowService(harness: EmbeddedHarness): Promise<WorkflowService> {
  await harness.runtime.registerPlugin({
    name: 'workflow-provider-integration-service',
    description: 'Real workflow facade for provider integration coverage',
    services: [WorkflowService],
  });
  return (await harness.runtime.getServiceLoadPromise(WORKFLOW_SERVICE_TYPE)) as WorkflowService;
}

async function createOwnedWorkflow(
  harness: EmbeddedHarness,
  name: string,
  integration = 'set'
): Promise<string> {
  const workflow = await harness.workflow.createWorkflow(workflowDefinition(name, integration));
  const tagName = `user_${USER_ID.replace(/-/g, '').slice(0, 8)}`;
  const tag = await harness.workflow.getOrCreateTag(tagName);
  await harness.workflow.updateWorkflowTags(workflow.id, [tag.id]);
  return workflow.id;
}

describe('workflow providers with real runtime services', () => {
  let harness: EmbeddedHarness;
  let service: WorkflowService;

  beforeEach(async () => {
    harness = await makeEmbeddedHarness(`provider-${crypto.randomUUID()}`);
    service = await registerWorkflowService(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  test('declares the provider gates and cache scopes consumed by workflow turns', () => {
    expect(activeWorkflowsProvider.contextGate).toEqual({
      anyOf: ['general', 'automation', 'tasks', 'connectors'],
    });
    expect(activeWorkflowsProvider.cacheScope).toBe('turn');
    expect(workflowStatusProvider.contextGate).toEqual({
      anyOf: ['automation', 'connectors'],
    });
    expect(pendingDraftProvider.cacheScope).toBe('conversation');
  });

  test('returns explicit empty workflow state from the real persistence path', async () => {
    const result = await activeWorkflowsProvider.get(harness.runtime, message(), state());

    expect(result).toEqual({
      text: '',
      data: { workflows: [] },
      values: { hasWorkflows: false },
    });
  });

  test('returns unavailable state when the workflow facade was never registered', async () => {
    const withoutFacade = await makeEmbeddedHarness(`provider-missing-${crypto.randomUUID()}`);
    try {
      const result = await activeWorkflowsProvider.get(withoutFacade.runtime, message(), state());
      expect(result).toEqual({ text: '', data: {}, values: {} });
    } finally {
      await withoutFacade.close();
    }
  });

  test('lists owned workflows with persisted activation and node counts', async () => {
    const activeId = await createOwnedWorkflow(harness, 'Stripe Payments');
    await service.activateWorkflow(activeId);
    await createOwnedWorkflow(harness, 'Daily Summary');

    const result = await activeWorkflowsProvider.get(
      harness.runtime,
      message('What happened this morning?'),
      state()
    );

    expect(result.text).toContain('Stripe Payments');
    expect(result.text).toContain('Daily Summary');
    expect(result.text).toContain('ACTIVE');
    expect(result.text).toContain('INACTIVE');
    expect(result.values).toEqual({ hasWorkflows: true, workflowCount: 2 });
    expect(result.data?.workflows).toEqual(
      expect.arrayContaining([
        { id: activeId, name: 'Stripe Payments', active: true, nodeCount: 2 },
      ])
    );
  });

  test('searches through the real workflow ranking path', async () => {
    await createOwnedWorkflow(harness, 'Gmail digest');
    const slackId = await createOwnedWorkflow(harness, 'Team notifications', 'slack');
    const query = 'find the workflow that posts to Slack';

    const result = await activeWorkflowsProvider.get(harness.runtime, message(query), state());

    expect(result.text).toContain('# Matching Workflows');
    expect(result.text).toContain('Team notifications');
    expect(result.text).not.toContain('Gmail digest');
    expect(result.data).toEqual({
      workflows: [
        {
          id: slackId,
          name: 'Team notifications',
          active: false,
          nodeCount: 2,
        },
      ],
      searchQuery: query,
    });
  });

  test('returns a designed no-match result for a real ranked search', async () => {
    await createOwnedWorkflow(harness, 'Daily Summary');
    const query = 'search workflows for calendar cleanup';

    const result = await activeWorkflowsProvider.get(harness.runtime, message(query), state());

    expect(result.text).toContain(`No workflows match "${query}".`);
    expect(result.data).toEqual({ workflows: [], searchQuery: query });
  });

  test('scopes persisted workflows by the message entity', async () => {
    await createOwnedWorkflow(harness, 'Owner workflow');

    const result = await activeWorkflowsProvider.get(
      harness.runtime,
      message('List workflows', OTHER_USER_ID),
      state()
    );

    expect(result.values).toEqual({
      hasWorkflows: false,
      workflowCount: 0,
      workflowSearchQuery: 'List workflows',
    });
  });

  test('surfaces a stopped workflow service as an observable provider failure', async () => {
    await service.stop();

    await expect(
      activeWorkflowsProvider.get(harness.runtime, message(), state())
    ).rejects.toMatchObject({
      code: 'WORKFLOW_PROVIDER_ACTIVE_LOAD_FAILED',
      cause: expect.objectContaining({ message: expect.stringContaining('not initialized') }),
    });
  });

  test('reports status and a real persisted execution', async () => {
    const workflowId = await createOwnedWorkflow(harness, 'Executable workflow');
    await harness.workflow.executeWorkflow(workflowId, {
      mode: 'manual',
      triggerData: { source: 'provider-test' },
    });

    const result = await workflowStatusProvider.get(harness.runtime, message(), state());

    expect(result.text).toContain('Executable workflow');
    expect(result.text).toContain('success');
    expect(result.values).toEqual({ workflowCount: 1 });
    expect(result.data?.workflows).toHaveLength(1);
  });

  test('renders execution history as unavailable and reports a real database failure', async () => {
    await createOwnedWorkflow(harness, 'History unavailable workflow');
    const database = harness.runtime.db as { execute(query: unknown): Promise<unknown> };
    await database.execute(sql`DROP TABLE workflow.embedded_executions`);

    const result = await workflowStatusProvider.get(harness.runtime, message(), state());

    expect(result.text).toContain('History unavailable workflow');
    expect(result.text).toContain('Last run: unavailable');
  });

  test('surfaces a stopped workflow facade as a status-provider failure', async () => {
    await service.stop();

    await expect(
      workflowStatusProvider.get(harness.runtime, message(), state())
    ).rejects.toMatchObject({
      code: 'WORKFLOW_PROVIDER_STATUS_LOAD_FAILED',
      cause: expect.objectContaining({ message: expect.stringContaining('not initialized') }),
    });
  });

  test('limits rendered status while retaining the persisted total', async () => {
    for (let index = 0; index < 12; index += 1) {
      await createOwnedWorkflow(harness, `Workflow ${index}`);
    }

    const result = await workflowStatusProvider.get(harness.runtime, message(), state());

    expect(result.text).toContain('2 more workflows');
    expect(result.values).toEqual({ workflowCount: 12 });
  });

  test('reads pending drafts through the real runtime cache', async () => {
    await harness.runtime.setCache(`workflow_draft:${USER_ID}`, {
      workflow: workflowDefinition('Gmail to Telegram'),
      prompt: 'Send gmail to telegram',
      userId: USER_ID,
      createdAt: Date.now(),
    });

    const result = await pendingDraftProvider.get(harness.runtime, message('yes'), state());

    expect(result.text).toContain('Gmail to Telegram');
    expect(result.text).toContain('Manual Trigger');
    expect(result.data).toEqual({ hasPendingDraft: true, truncated: false });
    expect(result.values).toEqual({ hasPendingDraft: true });
  });

  test('distinguishes missing, expired, and other-user drafts', async () => {
    const missing = await pendingDraftProvider.get(harness.runtime, message(), state());
    expect(missing).toEqual({ text: '', data: {}, values: {} });

    await harness.runtime.setCache(`workflow_draft:${USER_ID}`, {
      workflow: workflowDefinition('Expired workflow'),
      prompt: 'test',
      userId: USER_ID,
      createdAt: Date.now() - 31 * 60 * 1000,
    });

    const expired = await pendingDraftProvider.get(harness.runtime, message(), state());
    const otherUser = await pendingDraftProvider.get(
      harness.runtime,
      message('yes', OTHER_USER_ID),
      state()
    );
    expect(expired).toEqual({ text: '', data: {}, values: {} });
    expect(otherUser).toEqual({ text: '', data: {}, values: {} });
  });
});
