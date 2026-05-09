import { beforeEach, describe, expect, test } from 'bun:test';
import type { IAgentRuntime, Service, Task, UUID } from '@elizaos/core';
import { migrateLegacyWorkbenchTasks } from '../../src/lib/legacy-task-migration';
import { migrateLegacyTextTriggers } from '../../src/lib/legacy-text-trigger-migration';
import { WORKFLOW_SERVICE_TYPE } from '../../src/services/workflow-service';
import type { WorkflowCreationResult, WorkflowDefinition } from '../../src/types/index';

interface DeployCall {
  workflow: WorkflowDefinition;
  userId: string;
}

interface MockRuntime {
  runtime: IAgentRuntime;
  tasks: Task[];
  workflowService: MockWorkflowService;
  setWorkflowServiceRegistered(registered: boolean): void;
}

const AGENT_ID = '00000000-0000-0000-0000-00000000a601' as UUID;

let nextWorkflowId = 0;

function defaultDeploy(workflow: WorkflowDefinition): Promise<WorkflowCreationResult> {
  nextWorkflowId += 1;
  return Promise.resolve({
    id: `wf_${nextWorkflowId}`,
    name: workflow.name,
    active: true,
    nodeCount: workflow.nodes.length,
    missingCredentials: [],
  });
}

class MockWorkflowService extends WorkflowService {
  deployCalls: DeployCall[] = [];
  deployImpl: (workflow: WorkflowDefinition, userId: string) => Promise<WorkflowCreationResult> =
    defaultDeploy;

  override async stop(): Promise<void> {}

  override async deployWorkflow(
    workflow: WorkflowDefinition,
    userId: string
  ): Promise<WorkflowCreationResult> {
    this.deployCalls.push({ workflow, userId });
    return this.deployImpl(workflow, userId);
  }
}

function makeRuntime(initialTasks: Task[] = []): MockRuntime {
  const tasks = initialTasks.map((t) => ({ ...t, metadata: { ...(t.metadata ?? {}) } }));

  const workflowService = new MockWorkflowService();
  let workflowServiceRegistered = true;

  const runtime = {
    agentId: AGENT_ID,
    getService<T extends Service>(type: string): T | null {
      if (type === WORKFLOW_SERVICE_TYPE && workflowServiceRegistered) {
        return workflowService as T;
      }
      return null;
    },
    async getTasks(params: { agentIds: UUID[]; tags?: string[] }) {
      return tasks.filter((t) => {
        if (!params.agentIds.includes(t.agentId ?? AGENT_ID)) return false;
        if (params.tags && params.tags.length > 0) {
          return params.tags.every((tag) => t.tags?.includes(tag));
        }
        return true;
      });
    },
    async getTasksByName(name: string) {
      return tasks.filter((t) => t.name === name);
    },
    async updateTask(id: UUID, partial: Partial<Task>) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) throw new Error(`task ${id} not found`);
      const existing = tasks[idx];
      tasks[idx] = {
        ...existing,
        ...partial,
        metadata: partial.metadata
          ? { ...(partial.metadata as Record<string, unknown>) }
          : existing.metadata,
      };
    },
  } as IAgentRuntime;

  return {
    runtime,
    tasks,
    workflowService,
    setWorkflowServiceRegistered(registered: boolean) {
      workflowServiceRegistered = registered;
    },
  };
}

function makeWorkbenchTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id: id as UUID,
    name: `Workbench Task ${id}`,
    description: `do thing ${id}`,
    tags: ['workbench-task'],
    agentId: AGENT_ID,
    ...overrides,
    metadata: { ...(overrides.metadata ?? {}) },
  };
}

function makeTriggerTask(id: string, triggerOverrides: Record<string, unknown> = {}): Task {
  return {
    id: id as UUID,
    name: 'TRIGGER_DISPATCH',
    description: '',
    tags: ['queue', 'repeat', 'trigger'],
    agentId: AGENT_ID,
    metadata: {
      trigger: {
        triggerId: `trig-${id}`,
        version: 1,
        displayName: `Trigger ${id}`,
        instructions: `instructions ${id}`,
        triggerType: 'interval',
        wakeMode: 'inject_now',
        enabled: true,
        createdBy: 'user',
        runCount: 0,
        kind: 'text',
        ...triggerOverrides,
      },
    },
  };
}

beforeEach(() => {
  nextWorkflowId = 0;
});

describe('migrateLegacyWorkbenchTasks', () => {
  test('converts a fresh workbench task into a workflow + marks the task migrated', async () => {
    const ctx = makeRuntime([makeWorkbenchTask('a')]);

    const summary = await migrateLegacyWorkbenchTasks(ctx.runtime);

    expect(summary).toEqual({ migrated: 1, skipped: 0, failed: 0 });
    expect(ctx.workflowService.deployCalls).toHaveLength(1);
    const deployed = ctx.workflowService.deployCalls[0];
    expect(deployed.workflow.nodes).toHaveLength(1);
    expect(deployed.workflow.nodes[0]?.type).toBe('workflows-nodes-base.respondToEvent');
    expect(deployed.workflow.nodes[0]?.parameters.instructions).toBe('do thing a');
    expect(deployed.workflow.nodes[0]?.parameters.wakeMode).toBe('inject_now');

    const migratedTask = ctx.tasks.find((t) => t.id === 'a');
    expect(migratedTask?.metadata?.migratedToWorkflowId).toBe('wf_1');
    expect(typeof migratedTask?.metadata?.migratedAt).toBe('number');
  });

  test('skips tasks already carrying migratedToWorkflowId', async () => {
    const ctx = makeRuntime([
      makeWorkbenchTask('already', { metadata: { migratedToWorkflowId: 'wf_existing' } }),
    ]);

    const summary = await migrateLegacyWorkbenchTasks(ctx.runtime);

    expect(summary).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(ctx.workflowService.deployCalls).toHaveLength(0);
  });

  test('is idempotent across two consecutive runs', async () => {
    const ctx = makeRuntime([makeWorkbenchTask('a'), makeWorkbenchTask('b')]);

    const first = await migrateLegacyWorkbenchTasks(ctx.runtime);
    const second = await migrateLegacyWorkbenchTasks(ctx.runtime);

    expect(first).toEqual({ migrated: 2, skipped: 0, failed: 0 });
    expect(second).toEqual({ migrated: 0, skipped: 2, failed: 0 });
    expect(ctx.workflowService.deployCalls).toHaveLength(2);
  });

  test('isolates per-task failures: bad deploy counts as failed, others succeed', async () => {
    const ctx = makeRuntime([makeWorkbenchTask('good'), makeWorkbenchTask('bad')]);

    ctx.workflowService.deployImpl = async (workflow) => {
      if (workflow.name.includes('bad')) {
        throw new Error('boom');
      }
      return defaultDeploy(workflow);
    };

    const summary = await migrateLegacyWorkbenchTasks(ctx.runtime);

    expect(summary).toEqual({ migrated: 1, skipped: 0, failed: 1 });
    const goodTask = ctx.tasks.find((t) => t.id === 'good');
    const badTask = ctx.tasks.find((t) => t.id === 'bad');
    expect(goodTask?.metadata?.migratedToWorkflowId).toBeDefined();
    expect(badTask?.metadata?.migratedToWorkflowId).toBeUndefined();
  });

  test('returns an empty summary when WorkflowService is not registered', async () => {
    const ctx = makeRuntime([makeWorkbenchTask('a')]);
    ctx.setWorkflowServiceRegistered(false);

    const summary = await migrateLegacyWorkbenchTasks(ctx.runtime);
    expect(summary).toEqual({ migrated: 0, skipped: 0, failed: 0 });
  });
});

describe('migrateLegacyTextTriggers', () => {
  test('converts a text-kind trigger into a workflow trigger', async () => {
    const ctx = makeRuntime([makeTriggerTask('t1')]);

    const summary = await migrateLegacyTextTriggers(ctx.runtime);

    expect(summary).toEqual({ migrated: 1, skipped: 0, failed: 0 });
    expect(ctx.workflowService.deployCalls).toHaveLength(1);
    const deployed = ctx.workflowService.deployCalls[0];
    expect(deployed.workflow.name).toBe('Trigger t1');
    expect(deployed.workflow.nodes[0]?.parameters.instructions).toBe('instructions t1');

    const migrated = ctx.tasks.find((t) => t.id === 't1');
    const trigger = migrated?.metadata?.trigger as Record<string, unknown> | undefined;
    expect(trigger?.kind).toBe('workflow');
    expect(trigger?.workflowId).toBe('wf_1');
    expect(trigger?.workflowName).toBe('Trigger t1');
    expect(migrated?.metadata?.migratedFromText).toBe(true);
  });

  test('treats undefined kind as legacy text and migrates', async () => {
    const ctx = makeRuntime([makeTriggerTask('legacy', { kind: undefined })]);

    const summary = await migrateLegacyTextTriggers(ctx.runtime);

    expect(summary).toEqual({ migrated: 1, skipped: 0, failed: 0 });
  });

  test('leaves workflow-kind triggers untouched', async () => {
    const ctx = makeRuntime([
      makeTriggerTask('wf', {
        kind: 'workflow',
        workflowId: 'wf_pre',
        workflowName: 'Pre-existing',
      }),
    ]);

    const summary = await migrateLegacyTextTriggers(ctx.runtime);

    expect(summary).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(ctx.workflowService.deployCalls).toHaveLength(0);
    const trigger = ctx.tasks[0]?.metadata?.trigger as Record<string, unknown>;
    expect(trigger?.kind).toBe('workflow');
    expect(trigger?.workflowId).toBe('wf_pre');
  });

  test('is idempotent across two consecutive runs', async () => {
    const ctx = makeRuntime([makeTriggerTask('a'), makeTriggerTask('b')]);

    const first = await migrateLegacyTextTriggers(ctx.runtime);
    const second = await migrateLegacyTextTriggers(ctx.runtime);

    expect(first).toEqual({ migrated: 2, skipped: 0, failed: 0 });
    expect(second).toEqual({ migrated: 0, skipped: 2, failed: 0 });
    expect(ctx.workflowService.deployCalls).toHaveLength(2);
  });

  test('isolates per-task failures during deploy', async () => {
    const ctx = makeRuntime([makeTriggerTask('good'), makeTriggerTask('bad')]);

    ctx.workflowService.deployImpl = async (workflow) => {
      if (workflow.name.includes('bad')) {
        throw new Error('boom');
      }
      return defaultDeploy(workflow);
    };

    const summary = await migrateLegacyTextTriggers(ctx.runtime);

    expect(summary).toEqual({ migrated: 1, skipped: 0, failed: 1 });
    const good = ctx.tasks.find((t) => t.id === 'good');
    const bad = ctx.tasks.find((t) => t.id === 'bad');
    expect((good?.metadata?.trigger as Record<string, unknown>)?.kind).toBe('workflow');
    expect((bad?.metadata?.trigger as Record<string, unknown>)?.kind).toBe('text');
    expect(bad?.metadata?.migratedFromText).toBeUndefined();
  });

  test('skips tasks without a triggerId in metadata', async () => {
    const malformed: Task = {
      id: 'malformed' as UUID,
      name: 'TRIGGER_DISPATCH',
      tags: ['trigger'],
      agentId: AGENT_ID,
      metadata: { trigger: { kind: 'text' } as Record<string, unknown> },
    };
    const ctx = makeRuntime([malformed]);

    const summary = await migrateLegacyTextTriggers(ctx.runtime);

    expect(summary).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(ctx.workflowService.deployCalls).toHaveLength(0);
  });

  test('returns an empty summary when WorkflowService is not registered', async () => {
    const ctx = makeRuntime([makeTriggerTask('a')]);
    ctx.setWorkflowServiceRegistered(false);

    const summary = await migrateLegacyTextTriggers(ctx.runtime);
    expect(summary).toEqual({ migrated: 0, skipped: 0, failed: 0 });
  });
});
