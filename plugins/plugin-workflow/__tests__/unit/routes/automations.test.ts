/** Unit tests for the `/api/automations` combined-view builder over an in-memory task/room runtime (deterministic). */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ServerResponse } from 'node:http';
import type { AgentRuntime, Room, Task, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import {
  __resetAutomationsCacheForTests,
  buildAutomationListResponse,
} from '../../../src/lib/automations-builder';
import type { AutomationListResponse } from '../../../src/lib/automations-types';
import { handleAutomationsRoutes } from '../../../src/routes/automations';
import { handleWorkflowRoutes } from '../../../src/routes/workflow-routes';
import { WORKFLOW_SERVICE_TYPE } from '../../../src/services/workflow-service';

const AGENT_NAME = 'Eliza';
const WORLD_ID = stringToUuid(`${AGENT_NAME}-web-chat-world`);
const DEFAULT_OWNER_ID = stringToUuid(`${AGENT_NAME}-admin-entity`);

type AutomationsRuntime = Pick<
  AgentRuntime,
  'agentId' | 'character' | 'getService' | 'getRooms' | 'getTasks' | 'reportError'
>;

interface RuntimeMockOptions {
  agentId?: UUID;
  rooms?: Room[];
  tasks?: Task[];
  triggerTasks?: Task[];
  heartbeatTasks?: Task[];
  workflows?: Array<Record<string, unknown>>;
  workflowsByOwner?: Record<string, Array<Record<string, unknown>>>;
  executions?: Array<Record<string, unknown>>;
  executionsByWorkflow?: Record<string, Array<Record<string, unknown>>>;
  executionErrorsByWorkflow?: Record<string, string>;
  runExecution?: Record<string, unknown>;
  workflowsThrows?: boolean;
}

function createWorkflowServiceMock(opts: RuntimeMockOptions) {
  return {
    listWorkflows: mock((ownerEntityId: string) => {
      if (opts.workflowsThrows) {
        return Promise.reject(new Error('workflow runtime offline'));
      }
      return Promise.resolve(opts.workflowsByOwner?.[ownerEntityId] ?? opts.workflows ?? []);
    }),
    listExecutions: mock(({ workflowId }: { workflowId?: string }) => {
      if (workflowId && opts.executionErrorsByWorkflow?.[workflowId]) {
        return Promise.reject(new Error(opts.executionErrorsByWorkflow[workflowId]));
      }
      return Promise.resolve({
        data: (workflowId && opts.executionsByWorkflow?.[workflowId]) ?? opts.executions ?? [],
        nextCursor: undefined,
      });
    }),
    runWorkflow: mock((workflowId: string) => {
      const execution = opts.runExecution ?? {
        id: 'exec-run',
        workflowId,
        status: 'success',
        startedAt: '2024-05-01T12:00:00.000Z',
        stoppedAt: '2024-05-01T12:00:01.000Z',
      };
      if (opts.runExecution && opts.executions) {
        opts.executions.unshift(execution);
      }
      return Promise.resolve(execution);
    }),
  };
}

function createRuntimeMock(opts: RuntimeMockOptions = {}): AgentRuntime {
  const agentId = opts.agentId ?? (stringToUuid('test-agent-001') as UUID);
  const workflowService = createWorkflowServiceMock(opts);
  const services: Record<string, unknown> = {
    [WORKFLOW_SERVICE_TYPE]: workflowService,
  };

  const runtimeDouble: AutomationsRuntime = {
    agentId,
    character: { id: agentId, name: AGENT_NAME },
    getService: mock((type: string) => services[type] ?? null),
    reportError: mock(() => {}),
    getRooms: mock((worldId: UUID) => {
      if (worldId !== WORLD_ID) return Promise.resolve([]);
      return Promise.resolve(opts.rooms ?? []);
    }),
    getTasks: mock(({ tags }: { tags?: string[] }) => {
      if (Array.isArray(tags) && tags.includes('repeat') && tags.includes('trigger')) {
        return Promise.resolve(opts.triggerTasks ?? []);
      }
      if (Array.isArray(tags) && tags.includes('repeat') && tags.includes('heartbeat')) {
        return Promise.resolve(opts.heartbeatTasks ?? []);
      }
      return Promise.resolve(opts.tasks ?? []);
    }),
  };

  return runtimeDouble as AgentRuntime;
}

beforeEach(() => {
  __resetAutomationsCacheForTests();
});

describe('buildAutomationListResponse', () => {
  test('combines workflows, triggers, and draft conversations into a single list', async () => {
    const workflowId = 'wf-9001';
    const triggerTaskId = stringToUuid('trigger-task-1') as UUID;
    const triggerId = stringToUuid('trigger-1') as UUID;
    const promptTriggerTaskId = stringToUuid('prompt-trigger-task-1') as UUID;
    const promptTriggerId = stringToUuid('prompt-trigger-1') as UUID;
    const draftRoomId = stringToUuid('draft-room-1') as UUID;

    const triggerTask: Task = {
      id: triggerTaskId,
      name: 'TRIGGER_DISPATCH',
      description: 'Daily morning briefing',
      tags: ['queue', 'repeat', 'trigger'],
      metadata: {
        updatedAt: 1_700_000_000_000,
        updateInterval: 86_400_000,
        trigger: {
          version: 1,
          triggerId,
          displayName: 'Morning briefing',
          instructions: 'Run morning briefing',
          triggerType: 'cron',
          enabled: true,
          wakeMode: 'inject_now',
          createdBy: DEFAULT_OWNER_ID,
          cronExpression: '0 7 * * *',
          runCount: 5,
          kind: 'workflow',
          workflowId,
          workflowName: 'Daily standup poster',
        },
      },
    } as Task;

    const promptTriggerTask: Task = {
      id: promptTriggerTaskId,
      name: 'TRIGGER_DISPATCH',
      description: 'Prepare a weekly summary',
      tags: ['queue', 'repeat', 'trigger'],
      metadata: {
        updatedAt: 1_700_000_000_000,
        updateInterval: 604_800_000,
        trigger: {
          version: 1,
          triggerId: promptTriggerId,
          displayName: 'Weekly summary',
          instructions: 'Prepare my weekly summary',
          triggerType: 'cron',
          enabled: true,
          wakeMode: 'inject_now',
          createdBy: DEFAULT_OWNER_ID,
          cronExpression: '0 17 * * 5',
          runCount: 2,
          kind: 'prompt',
        },
      },
    } as Task;

    const draftRoom: Room & { updatedAt?: unknown } = {
      id: draftRoomId,
      name: 'My new workflow draft',
      source: 'web',
      type: 'GROUP' as Room['type'],
      metadata: {
        ownership: { ownerId: DEFAULT_OWNER_ID },
        webConversation: {
          conversationId: 'conv-draft-1',
          scope: 'automation-workflow-draft',
          draftId: 'draft-abc',
          workflowName: 'Daily standup poster',
        },
      },
      updatedAt: '2024-05-01T12:00:00.000Z',
    };

    const runtime = createRuntimeMock({
      rooms: [draftRoom],
      triggerTasks: [triggerTask, promptTriggerTask],
      workflows: [
        {
          id: workflowId,
          name: 'Daily standup poster',
          active: true,
          nodes: [],
          connections: {},
          createdAt: '2024-04-01T00:00:00.000Z',
          updatedAt: '2024-04-15T00:00:00.000Z',
          versionId: 'v-1',
        },
      ],
      executions: [
        {
          id: 'exec-1',
          status: 'success',
          startedAt: '2024-05-01T08:00:00.000Z',
          stoppedAt: '2024-05-01T08:00:05.000Z',
        },
      ],
    });

    const result: AutomationListResponse = await buildAutomationListResponse(runtime);
    const workflowService = runtime.getService(WORKFLOW_SERVICE_TYPE) as ReturnType<
      typeof createWorkflowServiceMock
    >;
    const routeOwnerId = DEFAULT_OWNER_ID;

    expect(workflowService.listWorkflows).toHaveBeenCalledWith(routeOwnerId);
    expect(workflowService.listExecutions).toHaveBeenCalledWith(
      { workflowId, limit: 1 },
      routeOwnerId
    );

    expect(result.workflowFetchError).toBeNull();
    expect(result.executionFetchErrors).toEqual([]);
    const workflowItem = result.automations.find((item) => item.workflowId === workflowId);
    expect(workflowItem).toBeDefined();
    expect(workflowItem?.type).toBe('workflow');
    expect(workflowItem?.source).toBe('workflow');
    expect(workflowItem?.status).toBe('active');
    expect(workflowItem?.updatedAt).toBe('2024-04-15T00:00:00.000Z');
    expect(workflowItem?.lastExecution?.status).toBe('success');

    expect(workflowItem?.schedules).toHaveLength(1);
    expect(result.automations.find((item) => item.triggerId === triggerId)).toBeUndefined();

    const triggerItem = result.automations.find((item) => item.triggerId === promptTriggerId);
    expect(triggerItem).toBeDefined();
    expect(triggerItem?.type).toBe('coordinator_text');
    expect(triggerItem?.source).toBe('trigger');
    expect(triggerItem?.title).toBe('Weekly summary');
    expect(triggerItem?.schedules.length).toBe(1);

    const draftItem = result.automations.find((item) => item.id === 'workflow-draft:draft-abc');
    expect(draftItem).toBeDefined();
    expect(draftItem?.type).toBe('workflow');
    expect(draftItem?.source).toBe('workflow_draft');
    expect(draftItem?.status).toBe('draft');
    expect(draftItem?.isDraft).toBe(true);
    expect(draftItem?.room?.scope).toBe('automation-workflow-draft');

    expect(result.summary.workflowCount).toBe(2); // live workflow + draft
    expect(result.summary.coordinatorCount).toBe(1);
    expect(result.summary.scheduledCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.draftCount).toBe(1);
  });

  test('surfaces workflowFetchError and synthesizes shadow workflow rooms when service is offline', async () => {
    const workflowRoomId = stringToUuid('workflow-room-1') as UUID;
    const room: Room & { updatedAt?: unknown } = {
      id: workflowRoomId,
      name: 'Orphan workflow',
      source: 'web',
      type: 'GROUP' as Room['type'],
      metadata: {
        ownership: { ownerId: DEFAULT_OWNER_ID },
        webConversation: {
          conversationId: 'conv-1',
          scope: 'automation-workflow',
          workflowId: 'wf-orphan',
          workflowName: 'Orphan workflow',
        },
      },
      updatedAt: '2024-05-01T12:00:00.000Z',
    };

    const foreignRoom: Room & { updatedAt?: unknown } = {
      ...room,
      id: stringToUuid('foreign-workflow-room') as UUID,
      name: 'Foreign workflow',
      metadata: {
        ownership: { ownerId: stringToUuid('foreign-owner') },
        webConversation: {
          conversationId: 'conv-foreign',
          scope: 'automation-workflow',
          workflowId: 'wf-foreign',
          workflowName: 'Foreign workflow',
        },
      },
    };
    const runtime = createRuntimeMock({
      rooms: [room, foreignRoom],
      workflowsThrows: true,
    });

    const result = await buildAutomationListResponse(runtime);

    expect(result.workflowFetchError).toBe('workflow runtime offline');
    const shadow = result.automations.find((item) => item.workflowId === 'wf-orphan');
    expect(shadow).toBeDefined();
    expect(shadow?.source).toBe('workflow_shadow');
    expect(shadow?.hasBackingWorkflow).toBe(false);
    expect(result.automations.some((item) => item.workflowId === 'wf-foreign')).toBe(false);
  });

  test('reports execution-history failures separately from workflows that have never run', async () => {
    const runtime = createRuntimeMock({
      workflows: [
        {
          id: 'wf-empty',
          name: 'Never run',
          active: true,
          nodes: [],
          connections: {},
          createdAt: '2024-05-01T08:00:00.000Z',
          updatedAt: '2024-05-01T08:00:00.000Z',
          versionId: 'v-empty',
        },
        {
          id: 'wf-error',
          name: 'History unavailable',
          active: true,
          nodes: [],
          connections: {},
          createdAt: '2024-05-01T08:00:00.000Z',
          updatedAt: '2024-05-01T08:00:00.000Z',
          versionId: 'v-error',
        },
      ],
      executionsByWorkflow: { 'wf-empty': [] },
      executionErrorsByWorkflow: { 'wf-error': 'execution store unavailable' },
    });

    const result = await buildAutomationListResponse(runtime, DEFAULT_OWNER_ID);
    const empty = result.automations.find((item) => item.workflowId === 'wf-empty');
    const failed = result.automations.find((item) => item.workflowId === 'wf-error');

    expect(empty?.lastExecution).toBeUndefined();
    expect(empty?.executionFetchError).toBeUndefined();
    expect(failed?.lastExecution).toBeUndefined();
    expect(failed?.executionFetchError).toBe('execution store unavailable');
    expect(result.executionFetchErrors).toEqual([
      { workflowId: 'wf-error', error: 'execution store unavailable' },
    ]);
    expect(runtime.reportError).toHaveBeenCalledWith(
      'AutomationsBuilder.lastExecution',
      expect.any(Error),
      { ownerEntityId: DEFAULT_OWNER_ID, workflowId: 'wf-error' }
    );
  });

  test('invalidates the owner-scoped execution cache after an immediate workflow run', async () => {
    const workflowId = 'wf-run-now';
    const options: RuntimeMockOptions = {
      workflows: [
        {
          id: workflowId,
          name: 'Run now',
          active: true,
          nodes: [],
          connections: {},
          createdAt: '2024-05-01T08:00:00.000Z',
          updatedAt: '2024-05-01T08:00:00.000Z',
          versionId: 'v-run',
        },
      ],
      executions: [
        {
          id: 'exec-old',
          workflowId,
          status: 'success',
          startedAt: '2024-05-01T06:14:00.000Z',
          stoppedAt: '2024-05-01T06:14:01.000Z',
        },
      ],
      runExecution: {
        id: 'exec-new',
        workflowId,
        status: 'success',
        startedAt: '2024-05-01T06:47:00.000Z',
        stoppedAt: '2024-05-01T06:47:01.000Z',
      },
    };
    const runtime = createRuntimeMock(options);
    const before = await buildAutomationListResponse(runtime, DEFAULT_OWNER_ID);
    expect(before.automations[0]?.lastExecution?.startedAt).toBe('2024-05-01T06:14:00.000Z');

    let runStatus = 0;
    await handleWorkflowRoutes({
      req: { method: 'POST', url: `/api/workflow/workflows/${workflowId}/run` } as never,
      res: {} as ServerResponse,
      method: 'POST',
      pathname: `/api/workflow/workflows/${workflowId}/run`,
      runtime,
      principalId: DEFAULT_OWNER_ID,
      json: (_res, _body, status = 200) => {
        runStatus = status;
      },
    });

    const after = await buildAutomationListResponse(runtime, DEFAULT_OWNER_ID);
    const workflowService = runtime.getService(WORKFLOW_SERVICE_TYPE) as ReturnType<
      typeof createWorkflowServiceMock
    >;
    expect(runStatus).toBe(200);
    expect(workflowService.listExecutions).toHaveBeenCalledTimes(2);
    expect(after.automations[0]?.lastExecution?.startedAt).toBe('2024-05-01T06:47:00.000Z');
  });

  test('isolates cached executions between agent workflow services', async () => {
    const workflowId = 'shared-seeded-workflow-id';
    const workflow = {
      id: workflowId,
      name: 'Shared seeded workflow',
      active: true,
      nodes: [],
      connections: {},
      createdAt: '2024-05-01T08:00:00.000Z',
      updatedAt: '2024-05-01T08:00:00.000Z',
      versionId: 'v-1',
    };
    const firstRuntime = createRuntimeMock({
      agentId: stringToUuid('cache-agent-one') as UUID,
      workflows: [workflow],
      executions: [
        {
          id: 'exec-one',
          status: 'success',
          startedAt: '2024-05-01T09:00:00.000Z',
          stoppedAt: '2024-05-01T09:00:01.000Z',
        },
      ],
    });
    const secondRuntime = createRuntimeMock({
      agentId: stringToUuid('cache-agent-two') as UUID,
      workflows: [workflow],
      executions: [
        {
          id: 'exec-two',
          status: 'error',
          startedAt: '2024-05-01T10:00:00.000Z',
          stoppedAt: '2024-05-01T10:00:01.000Z',
        },
      ],
    });

    const firstResult = await buildAutomationListResponse(firstRuntime);
    const secondResult = await buildAutomationListResponse(secondRuntime);
    const secondService = secondRuntime.getService(WORKFLOW_SERVICE_TYPE) as ReturnType<
      typeof createWorkflowServiceMock
    >;

    expect(firstResult.automations[0]?.lastExecution?.status).toBe('success');
    expect(secondResult.automations[0]?.lastExecution?.status).toBe('error');
    expect(secondService.listExecutions).toHaveBeenCalledTimes(1);
  });
});

describe('handleAutomationsRoutes', () => {
  test('responds 200 with the list payload on GET /api/automations', async () => {
    const runtime = createRuntimeMock();

    let captured: { status: number; body: unknown } | null = null;
    const res = {} as ServerResponse;
    const handled = await handleAutomationsRoutes({
      req: { method: 'GET', url: '/api/automations' } as never,
      res,
      method: 'GET',
      pathname: '/api/automations',
      runtime,
      json: (_res, body, status = 200) => {
        captured = { status, body };
      },
    });

    expect(handled).toBe(true);
    expect(captured).not.toBeNull();
    const captured2 = captured as { status: number; body: AutomationListResponse } | null;
    expect(captured2?.status).toBe(200);
    expect(Array.isArray(captured2?.body.automations)).toBe(true);
    expect(captured2?.body.summary).toBeDefined();
  });

  test('isolates rooms, drafts, tasks, triggers, and workflows for two principals on one agent', async () => {
    const ownerA = stringToUuid('automations-owner-a') as UUID;
    const ownerB = stringToUuid('automations-owner-b') as UUID;
    const makeDraftRoom = (ownerId: UUID, suffix: string): Room => ({
      id: stringToUuid(`draft-room-${suffix}`) as UUID,
      name: `Draft ${suffix}`,
      source: 'web',
      type: 'GROUP' as Room['type'],
      metadata: {
        ownership: { ownerId },
        webConversation: {
          conversationId: `conversation-${suffix}`,
          scope: 'automation-workflow-draft',
          draftId: 'shared-draft-id',
          workflowName: `Draft ${suffix}`,
        },
      },
    });
    const makeTask = (ownerId: UUID, suffix: string): Task => ({
      id: stringToUuid(`workbench-task-${suffix}`) as UUID,
      entityId: ownerId,
      name: `Task ${suffix}`,
      description: `Owned task ${suffix}`,
      tags: ['workbench-task'],
      metadata: { ownership: { ownerId } },
    });
    const makePromptTrigger = (ownerId: UUID, suffix: string): Task => ({
      id: stringToUuid(`prompt-trigger-task-${suffix}`) as UUID,
      name: 'TRIGGER_DISPATCH',
      tags: ['queue', 'repeat', 'trigger'],
      metadata: {
        trigger: {
          version: 1,
          triggerId: stringToUuid(`prompt-trigger-${suffix}`),
          displayName: `Prompt ${suffix}`,
          instructions: `Run prompt ${suffix}`,
          triggerType: 'cron',
          enabled: true,
          wakeMode: 'inject_now',
          createdBy: ownerId,
          cronExpression: '0 8 * * *',
          runCount: 0,
          kind: 'prompt',
        },
      },
    });
    const foreignWorkflowTrigger: Task = {
      id: stringToUuid('foreign-workflow-trigger-task') as UUID,
      name: 'TRIGGER_DISPATCH',
      tags: ['queue', 'repeat', 'trigger'],
      metadata: {
        trigger: {
          version: 1,
          triggerId: stringToUuid('foreign-workflow-trigger'),
          displayName: 'Foreign workflow schedule',
          instructions: 'Run a workflow outside this owner scope',
          triggerType: 'cron',
          enabled: true,
          wakeMode: 'inject_now',
          createdBy: ownerA,
          cronExpression: '0 9 * * *',
          runCount: 0,
          kind: 'workflow',
          workflowId: 'wf-owner-b',
          workflowName: 'Workflow B',
        },
      },
    } as Task;
    const workflow = (id: string, name: string) => ({
      id,
      name,
      active: true,
      nodes: [],
      connections: {},
      createdAt: '2024-05-01T08:00:00.000Z',
      updatedAt: '2024-05-01T08:00:00.000Z',
      versionId: `version-${id}`,
    });
    const runtime = createRuntimeMock({
      rooms: [makeDraftRoom(ownerA, 'A'), makeDraftRoom(ownerB, 'B')],
      tasks: [makeTask(ownerA, 'A'), makeTask(ownerB, 'B')],
      triggerTasks: [
        makePromptTrigger(ownerA, 'A'),
        makePromptTrigger(ownerB, 'B'),
        foreignWorkflowTrigger,
      ],
      workflowsByOwner: {
        [ownerA]: [workflow('wf-owner-a', 'Workflow A')],
        [ownerB]: [workflow('wf-owner-b', 'Workflow B')],
      },
    });

    const loadFor = async (principalId: string): Promise<AutomationListResponse> => {
      let body: AutomationListResponse | null = null;
      await handleAutomationsRoutes({
        req: { method: 'GET', url: '/api/automations' } as never,
        res: {} as ServerResponse,
        method: 'GET',
        pathname: '/api/automations',
        runtime,
        principalId,
        json: (_res, payload) => {
          body = payload as AutomationListResponse;
        },
      });
      if (!body) throw new Error(`No automations response for ${principalId}`);
      return body;
    };

    const responseA = await loadFor(ownerA);
    const responseB = await loadFor(ownerB);
    const titlesA = responseA.automations.map((item) => item.title);
    const titlesB = responseB.automations.map((item) => item.title);

    expect(titlesA).toEqual(
      expect.arrayContaining(['Draft A', 'Task A', 'Prompt A', 'Workflow A'])
    );
    expect(titlesA).not.toEqual(
      expect.arrayContaining(['Draft B', 'Task B', 'Prompt B', 'Workflow B'])
    );
    expect(titlesB).toEqual(
      expect.arrayContaining(['Draft B', 'Task B', 'Prompt B', 'Workflow B'])
    );
    expect(titlesB).not.toEqual(
      expect.arrayContaining(['Draft A', 'Task A', 'Prompt A', 'Workflow A'])
    );
    expect(
      responseA.automations.find((item) => item.draftId === 'shared-draft-id')?.room?.roomId
    ).toBe(stringToUuid('draft-room-A'));
    expect(
      responseB.automations.find((item) => item.draftId === 'shared-draft-id')?.room?.roomId
    ).toBe(stringToUuid('draft-room-B'));
    expect(responseA.automations.some((item) => item.workflowId === 'wf-owner-b')).toBe(false);

    const service = runtime.getService(WORKFLOW_SERVICE_TYPE) as ReturnType<
      typeof createWorkflowServiceMock
    >;
    expect(service.listWorkflows).toHaveBeenCalledWith(ownerA);
    expect(service.listWorkflows).toHaveBeenCalledWith(ownerB);
  });

  test('returns 503 when runtime is missing', async () => {
    let captured: { status: number; body: unknown } | null = null;
    const handled = await handleAutomationsRoutes({
      req: { method: 'GET', url: '/api/automations' } as never,
      res: {} as ServerResponse,
      method: 'GET',
      pathname: '/api/automations',
      runtime: null,
      json: (_res, body, status = 200) => {
        captured = { status, body };
      },
    });

    expect(handled).toBe(true);
    expect(captured).not.toBeNull();
    const captured2 = captured as { status: number; body: { error: string } } | null;
    expect(captured2?.status).toBe(503);
    expect(captured2?.body.error).toContain('runtime');
  });

  test('returns false for non-matching paths', async () => {
    const runtime = createRuntimeMock();
    const handled = await handleAutomationsRoutes({
      req: { method: 'GET', url: '/api/other' } as never,
      res: {} as ServerResponse,
      method: 'GET',
      pathname: '/api/other',
      runtime,
      json: () => {},
    });
    expect(handled).toBe(false);
  });
});
