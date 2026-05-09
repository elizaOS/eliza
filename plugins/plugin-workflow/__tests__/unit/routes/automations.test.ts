import { describe, expect, mock, test, beforeEach } from 'bun:test';
import type { ServerResponse } from 'node:http';
import type { AgentRuntime, Room, Task, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import {
  __resetAutomationsCacheForTests,
  buildAutomationListResponse,
} from '../../../src/lib/automations-builder';
import type { AutomationListResponse } from '../../../src/lib/automations-types';
import { handleAutomationsRoutes } from '../../../src/routes/automations';
import { WORKFLOW_SERVICE_TYPE } from '../../../src/services/workflow-service';

const AGENT_NAME = 'Eliza';
const WORLD_ID = stringToUuid(`${AGENT_NAME}-web-chat-world`);

type AutomationsRuntime = Pick<AgentRuntime, 'agentId' | 'character' | 'getService' | 'getRooms' | 'getTasks'>;

interface RuntimeMockOptions {
  agentId?: UUID;
  rooms?: Room[];
  tasks?: Task[];
  triggerTasks?: Task[];
  heartbeatTasks?: Task[];
  workflows?: Array<Record<string, unknown>>;
  executions?: Array<Record<string, unknown>>;
  workflowsThrows?: boolean;
}

function createWorkflowServiceMock(opts: RuntimeMockOptions) {
  return {
    listWorkflows: mock(() => {
      if (opts.workflowsThrows) {
        return Promise.reject(new Error('workflow runtime offline'));
      }
      return Promise.resolve(opts.workflows ?? []);
    }),
    listExecutions: mock(() =>
      Promise.resolve({ data: opts.executions ?? [], nextCursor: undefined })
    ),
  };
}

function createRuntimeMock(opts: RuntimeMockOptions = {}): AgentRuntime {
  const agentId =
    opts.agentId ?? (stringToUuid('test-agent-001') as UUID);
  const workflowService = createWorkflowServiceMock(opts);
  const services: Record<string, unknown> = {
    [WORKFLOW_SERVICE_TYPE]: workflowService,
  };

  const runtimeDouble: AutomationsRuntime = {
    agentId,
    character: { id: agentId, name: AGENT_NAME },
    getService: mock((type: string) => services[type] ?? null),
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
          createdBy: 'user-1',
          cronExpression: '0 7 * * *',
          runCount: 5,
          kind: 'text',
        },
      },
    } as Task;

    const draftRoom: Room & { updatedAt?: unknown } = {
      id: draftRoomId,
      name: 'My new workflow draft',
      source: 'web',
      type: 'GROUP' as Room['type'],
      metadata: {
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
      triggerTasks: [triggerTask],
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

    expect(result.workflowFetchError).toBeNull();
    const workflowItem = result.automations.find((item) => item.workflowId === workflowId);
    expect(workflowItem).toBeDefined();
    expect(workflowItem?.type).toBe('workflow');
    expect(workflowItem?.source).toBe('workflow');
    expect(workflowItem?.status).toBe('active');
    expect(workflowItem?.lastExecution?.status).toBe('success');

    const triggerItem = result.automations.find((item) => item.triggerId === triggerId);
    expect(triggerItem).toBeDefined();
    expect(triggerItem?.type).toBe('coordinator_text');
    expect(triggerItem?.source).toBe('trigger');
    expect(triggerItem?.title).toBe('Morning briefing');
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
        webConversation: {
          conversationId: 'conv-1',
          scope: 'automation-workflow',
          workflowId: 'wf-orphan',
          workflowName: 'Orphan workflow',
        },
      },
      updatedAt: '2024-05-01T12:00:00.000Z',
    };

    const runtime = createRuntimeMock({
      rooms: [room],
      workflowsThrows: true,
    });

    const result = await buildAutomationListResponse(runtime);

    expect(result.workflowFetchError).toBe('workflow runtime offline');
    const shadow = result.automations.find((item) => item.workflowId === 'wf-orphan');
    expect(shadow).toBeDefined();
    expect(shadow?.source).toBe('workflow_shadow');
    expect(shadow?.hasBackingWorkflow).toBe(false);
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
