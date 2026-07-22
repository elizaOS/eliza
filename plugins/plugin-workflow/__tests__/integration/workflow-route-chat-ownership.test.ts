/**
 * Cross-surface ownership and lifecycle coverage over the real HTTP dispatcher,
 * WorkflowService, EmbeddedWorkflowService, PGlite store, WORKFLOW action, and
 * core task scheduler. Only natural-language generation is replaced with a
 * deterministic draft because model quality is outside this boundary test.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  stringToUuid,
} from '@elizaos/core';
import { tryHandleRuntimePluginRoute } from '../../../../packages/agent/src/api/runtime-plugin-routes';
import { workflowAction } from '../../src/actions/workflow';
import { workflowRoutePlugin } from '../../src/plugin-routes';
import { pendingDraftProvider } from '../../src/providers/pendingDraft';
import { DEVICE_HEALTH_CHECK_WORKFLOW_ID } from '../../src/services/embedded-workflow-service';
import { WORKFLOW_SERVICE_TYPE, WorkflowService } from '../../src/services/workflow-service';
import type { WorkflowDefinition, WorkflowExecution } from '../../src/types/index';
import { getUserTagName } from '../../src/utils/context';
import { type EmbeddedHarness, makeEmbeddedHarness } from './embedded-harness';

setDefaultTimeout(120_000);

const OWNER_ENTITY_ID = stringToUuid('workflow-local-owner');
const LINKED_OWNER_ENTITY_ID = stringToUuid('workflow-linked-owner');
const FOREIGN_ENTITY_ID = stringToUuid('workflow-foreign-owner');
const CHAT_ROOM_ID = stringToUuid('workflow-route-chat-owner-room');
const servers: http.Server[] = [];
const harnesses: EmbeddedHarness[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

function manualWorkflow(name: string): WorkflowDefinition {
  return {
    name,
    nodes: [
      {
        id: 'manual',
        name: 'Manual Trigger',
        type: 'workflows-nodes-base.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'set',
        name: 'Set Result',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [200, 0],
        parameters: {
          assignments: { assignments: [{ name: 'validated', value: true }] },
        },
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Set Result', type: 'main', index: 0 }]] },
    },
  };
}

function scheduledWorkflow(name: string): WorkflowDefinition {
  return {
    name,
    nodes: [
      {
        id: 'schedule',
        name: 'Schedule Trigger',
        type: 'workflows-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 0],
        parameters: { intervalMs: 60_000 },
      },
      {
        id: 'set',
        name: 'Set Result',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [200, 0],
        parameters: {
          assignments: { assignments: [{ name: 'scheduled', value: true }] },
        },
      },
    ],
    connections: {
      'Schedule Trigger': { main: [[{ node: 'Set Result', type: 'main', index: 0 }]] },
    },
  };
}

async function makeHarness(options: { seedDefaults?: boolean } = {}): Promise<{
  harness: EmbeddedHarness;
  workflowService: WorkflowService;
  baseUrl: string;
}> {
  const harness = await makeEmbeddedHarness('workflow-route-chat-owner-agent', options);
  harnesses.push(harness);
  harness.runtime.setSetting('ELIZA_ADMIN_ENTITY_ID', OWNER_ENTITY_ID);
  await harness.runtime.registerPlugin({
    name: 'workflow-route-chat-service-harness',
    description: 'Real WorkflowService for route/action ownership coverage',
    services: [WorkflowService],
  });
  await harness.runtime.registerPlugin(workflowRoutePlugin);
  const workflowService = (await harness.runtime.getServiceLoadPromise(
    WORKFLOW_SERVICE_TYPE
  )) as WorkflowService;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? 'GET',
      pathname: url.pathname,
      url,
      runtime: harness.runtime,
      isAuthorized: () => true,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { harness, workflowService, baseUrl: `http://127.0.0.1:${port}` };
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: {
      ...options.headers,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined
      ? {}
      : {
          body: JSON.stringify(options.body),
        }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function runChatAction(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  entityId = OWNER_ENTITY_ID,
  roomId = CHAT_ROOM_ID
) {
  if (!workflowAction.handler) throw new Error('WORKFLOW handler is unavailable');
  return workflowAction.handler(
    runtime,
    chatMessage(entityId, `WORKFLOW ${String(parameters.action ?? '')}`, roomId),
    undefined,
    {
      parameters,
    } as HandlerOptions
  );
}

function chatMessage(entityId: string, text: string, roomId = CHAT_ROOM_ID): Memory {
  return {
    id: stringToUuid(`workflow-chat-message:${crypto.randomUUID()}`),
    agentId: stringToUuid('workflow-route-chat-owner-agent'),
    entityId,
    roomId,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

function providerState(): State {
  return { data: {}, values: {}, text: '' };
}

async function tagForOwner(
  harness: EmbeddedHarness,
  workflowId: string,
  ownerEntityId: string
): Promise<void> {
  const tag = await harness.workflow.getOrCreateTag(
    await getUserTagName(harness.runtime, ownerEntityId)
  );
  await harness.workflow.updateWorkflowTags(workflowId, [tag.id]);
}

async function workflowScheduleTasks(
  harness: EmbeddedHarness,
  workflowId: string
): Promise<unknown[]> {
  const tasks = await harness.runtime.getTasks({ tags: ['workflow'] });
  return tasks.filter(
    (task) => (task.metadata as Record<string, unknown> | undefined)?.workflowId === workflowId
  );
}

describe('local workflow route/chat ownership and lifecycle', () => {
  test('the untagged seeded default has real backing routes for the canonical local owner', async () => {
    const { harness, baseUrl } = await makeHarness({ seedDefaults: true });

    const uiList = await requestJson(baseUrl, '/api/automations');
    expect(uiList.status).toBe(200);
    const defaultAutomation = (uiList.body.automations as Array<Record<string, unknown>>).find(
      (item) => item.workflowId === DEVICE_HEALTH_CHECK_WORKFLOW_ID
    );
    expect(defaultAutomation).toMatchObject({
      workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
      source: 'workflow',
      hasBackingWorkflow: true,
    });

    const opened = await requestJson(
      baseUrl,
      `/api/workflow/workflows/${DEVICE_HEALTH_CHECK_WORKFLOW_ID}`
    );
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      id: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
      active: true,
    });

    const updated = await requestJson(
      baseUrl,
      `/api/workflow/workflows/${DEVICE_HEALTH_CHECK_WORKFLOW_ID}`,
      {
        method: 'PUT',
        body: { ...opened.body, name: 'Edited Device Health Check' },
      }
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
      name: 'Edited Device Health Check',
      active: true,
    });

    const linkedOwnerChatGet = await runChatAction(
      harness.runtime,
      { action: 'get', workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID },
      FOREIGN_ENTITY_ID
    );
    expect(linkedOwnerChatGet.success).toBe(true);

    const run = await requestJson(
      baseUrl,
      `/api/workflow/workflows/${DEVICE_HEALTH_CHECK_WORKFLOW_ID}/run`,
      { method: 'POST' }
    );
    expect(run.status).toBe(200);
    expect(run.body.execution).toMatchObject({
      workflowId: DEVICE_HEALTH_CHECK_WORKFLOW_ID,
      status: 'success',
    });
  });

  test('UI writes are visible to chat, chat writes are visible to UI, and foreign resources are non-oracular', async () => {
    const { harness, workflowService, baseUrl } = await makeHarness();

    const uiCreated = await requestJson(baseUrl, '/api/workflow/workflows', {
      method: 'POST',
      body: manualWorkflow('Created in UI'),
      // Legacy plugin-route headers are caller-controlled and must never
      // override the authenticated local owner's canonical entity scope.
      headers: { 'x-eliza-entity-id': FOREIGN_ENTITY_ID },
    });
    expect(uiCreated.status).toBe(200);
    expect(uiCreated.body).toMatchObject({ name: 'Created in UI', active: false });
    const uiWorkflowId = String(uiCreated.body.id);

    const chatList = await runChatAction(harness.runtime, { action: 'list' });
    expect(chatList.success).toBe(true);
    expect(chatList.data).toMatchObject({
      workflows: [expect.objectContaining({ id: uiWorkflowId, name: 'Created in UI' })],
    });

    Reflect.set(
      workflowService,
      'generateWorkflowDraft',
      async (_prompt: string, options?: { userId?: string }) => {
        expect(options?.userId).toBe(OWNER_ENTITY_ID);
        return {
          ...manualWorkflow('Created in chat'),
          _meta: {
            requiresClarification: [
              {
                kind: 'recipient' as const,
                question: 'Who should receive the generated result?',
                paramPath: 'nodes["Set Result"].parameters.recipient',
              },
            ],
          },
        };
      }
    );
    const chatNeedsClarification = await runChatAction(
      harness.runtime,
      {
        action: 'create',
        seedPrompt: 'Create a workflow from chat.',
      },
      LINKED_OWNER_ENTITY_ID
    );
    expect(chatNeedsClarification.success).toBe(false);
    expect(chatNeedsClarification.values).toMatchObject({ status: 'needs_clarification' });
    expect(
      (await workflowService.listWorkflows(OWNER_ENTITY_ID)).map((item) => item.name)
    ).not.toContain('Created in chat');

    const pendingContext = await pendingDraftProvider.get(
      harness.runtime,
      chatMessage(LINKED_OWNER_ENTITY_ID, 'Send it to owner@example.com.'),
      providerState()
    );
    expect(pendingContext.text).toContain('Created in chat');
    expect(pendingContext.text).toContain('Who should receive the generated result?');
    expect(pendingContext.text).toContain('nodes["Set Result"].parameters.recipient');
    expect(pendingContext.values).toEqual({ hasPendingDraft: true });

    const otherConversationContext = await pendingDraftProvider.get(
      harness.runtime,
      chatMessage(
        LINKED_OWNER_ENTITY_ID,
        'Send it to owner@example.com.',
        stringToUuid('workflow-route-chat-other-room')
      ),
      providerState()
    );
    expect(otherConversationContext).toEqual({ text: '', data: {}, values: {} });

    const chatCreated = await runChatAction(
      harness.runtime,
      {
        action: 'create',
        resolutions: [
          {
            paramPath: 'nodes["Set Result"].parameters.recipient',
            value: 'owner@example.com',
          },
        ],
      },
      LINKED_OWNER_ENTITY_ID
    );
    expect(chatCreated.success).toBe(true);
    expect(chatCreated.values).toMatchObject({ active: false });
    const chatWorkflowId = String(chatCreated.values?.workflowId);

    const clearedContext = await pendingDraftProvider.get(
      harness.runtime,
      chatMessage(LINKED_OWNER_ENTITY_ID, 'Is anything still pending?'),
      providerState()
    );
    expect(clearedContext).toEqual({ text: '', data: {}, values: {} });

    const canceledDraft = await runChatAction(
      harness.runtime,
      { action: 'create', seedPrompt: 'Create another workflow, then cancel it.' },
      LINKED_OWNER_ENTITY_ID
    );
    expect(canceledDraft.values).toMatchObject({ status: 'needs_clarification' });
    const canceled = await runChatAction(
      harness.runtime,
      { action: 'cancel' },
      LINKED_OWNER_ENTITY_ID
    );
    expect(canceled).toMatchObject({
      success: true,
      data: { status: 'canceled', workflowName: 'Created in chat' },
    });
    const canceledContext = await pendingDraftProvider.get(
      harness.runtime,
      chatMessage(LINKED_OWNER_ENTITY_ID, 'What is pending now?'),
      providerState()
    );
    expect(canceledContext).toEqual({ text: '', data: {}, values: {} });

    const uiList = await requestJson(baseUrl, '/api/automations');
    expect(uiList.status).toBe(200);
    const uiAutomations = uiList.body.automations as Array<Record<string, unknown>>;
    expect(uiAutomations.map((item) => item.workflowId)).toEqual(
      expect.arrayContaining([uiWorkflowId, chatWorkflowId])
    );

    const openedChatWorkflow = await requestJson(
      baseUrl,
      `/api/workflow/workflows/${encodeURIComponent(chatWorkflowId)}`
    );
    expect(openedChatWorkflow.status).toBe(200);
    expect(openedChatWorkflow.body).toMatchObject({
      id: chatWorkflowId,
      name: 'Created in chat',
    });

    const ownedRun = await requestJson(
      baseUrl,
      `/api/workflow/workflows/${encodeURIComponent(chatWorkflowId)}/run`,
      { method: 'POST' }
    );
    expect(ownedRun.status).toBe(200);
    const ownedExecution = ownedRun.body.execution as WorkflowExecution;
    expect(ownedExecution).toMatchObject({ workflowId: chatWorkflowId, status: 'success' });

    const foreignWorkflow = await harness.workflow.createWorkflow(
      manualWorkflow('Foreign workflow')
    );
    await tagForOwner(harness, foreignWorkflow.id, FOREIGN_ENTITY_ID);
    const foreignExecution = await harness.workflow.executeWorkflow(foreignWorkflow.id);

    const ownerListAfterForeignCreate = await requestJson(baseUrl, '/api/automations');
    expect(
      (ownerListAfterForeignCreate.body.automations as Array<Record<string, unknown>>).some(
        (item) => item.workflowId === foreignWorkflow.id
      )
    ).toBe(false);

    const notFoundBody = {
      error: 'Workflow resource not found',
      code: 'workflow_resource_not_found',
    };
    for (const [path, method] of [
      [`/api/workflow/workflows/${foreignWorkflow.id}`, 'GET'],
      [`/api/workflow/workflows/${foreignWorkflow.id}/revisions`, 'GET'],
      [`/api/workflow/workflows/${foreignWorkflow.id}/run`, 'POST'],
      [`/api/workflow/workflows/${foreignWorkflow.id}`, 'DELETE'],
      [`/api/workflow/executions/${foreignExecution.id}`, 'GET'],
    ] as const) {
      const denied = await requestJson(baseUrl, path, { method });
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(notFoundBody);
    }

    const absentExecution = await requestJson(
      baseUrl,
      '/api/workflow/executions/execution-that-does-not-exist'
    );
    expect(absentExecution.status).toBe(404);
    expect(absentExecution.body).toEqual(notFoundBody);

    const absentRevisions = await requestJson(
      baseUrl,
      '/api/workflow/workflows/workflow-that-does-not-exist/revisions'
    );
    expect(absentRevisions.status).toBe(404);
    expect(absentRevisions.body).toEqual(notFoundBody);

    const foreignChatGet = await runChatAction(harness.runtime, {
      action: 'get',
      workflowId: foreignWorkflow.id,
    });
    expect(foreignChatGet.success).toBe(false);
    expect(foreignChatGet.text).toContain('not found');
    const foreignChatExecution = await runChatAction(harness.runtime, {
      action: 'diagnose',
      executionId: foreignExecution.id,
    });
    expect(foreignChatExecution.success).toBe(false);
    expect(foreignChatExecution.text).toContain('not found');

    expect((await harness.workflow.getWorkflow(foreignWorkflow.id)).name).toBe('Foreign workflow');
  });

  test('Save creates drafts, preserves active/paused state, and arms schedules only on explicit activation', async () => {
    const { harness, baseUrl } = await makeHarness();

    const created = await requestJson(baseUrl, '/api/workflow/workflows', {
      method: 'POST',
      body: scheduledWorkflow('Scheduled draft'),
    });
    expect(created.status).toBe(200);
    expect(created.body.active).toBe(false);
    const workflowId = String(created.body.id);
    expect(await workflowScheduleTasks(harness, workflowId)).toHaveLength(0);

    const activated = await requestJson(baseUrl, `/api/workflow/workflows/${workflowId}/activate`, {
      method: 'POST',
    });
    expect(activated.status).toBe(200);
    expect(activated.body.active).toBe(true);
    expect(await workflowScheduleTasks(harness, workflowId)).toHaveLength(1);

    const savedActive = await requestJson(baseUrl, `/api/workflow/workflows/${workflowId}`, {
      method: 'PUT',
      body: scheduledWorkflow('Scheduled active edit'),
    });
    expect(savedActive.status).toBe(200);
    expect(savedActive.body).toMatchObject({ name: 'Scheduled active edit', active: true });
    expect(await workflowScheduleTasks(harness, workflowId)).toHaveLength(1);

    const deactivated = await requestJson(
      baseUrl,
      `/api/workflow/workflows/${workflowId}/deactivate`,
      { method: 'POST' }
    );
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.active).toBe(false);
    expect(await workflowScheduleTasks(harness, workflowId)).toHaveLength(0);

    const savedPaused = await requestJson(baseUrl, `/api/workflow/workflows/${workflowId}`, {
      method: 'PUT',
      body: { ...scheduledWorkflow('Scheduled paused edit'), active: true },
    });
    expect(savedPaused.status).toBe(200);
    expect(savedPaused.body).toMatchObject({ name: 'Scheduled paused edit', active: false });
    expect(await workflowScheduleTasks(harness, workflowId)).toHaveLength(0);

    const explicitlyActive = await requestJson(baseUrl, '/api/workflow/workflows', {
      method: 'POST',
      body: { workflow: scheduledWorkflow('Explicitly active'), activate: true },
    });
    expect(explicitlyActive.status).toBe(200);
    expect(explicitlyActive.body.active).toBe(true);
    expect(await workflowScheduleTasks(harness, String(explicitlyActive.body.id))).toHaveLength(1);
  });
});
