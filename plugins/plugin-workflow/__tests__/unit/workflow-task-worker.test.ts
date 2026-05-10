import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime, Task, TaskWorker } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import {
  EmbeddedWorkflowService,
  WORKFLOW_RUN_TASK_WORKER_NAME,
  WORKFLOW_TASK_KIND,
  WORKFLOW_WEBHOOK_TASK_WORKER_NAME,
} from '../../src/services/embedded-workflow-service';

setDefaultTimeout(30_000);

interface TestRuntimeContext {
  runtime: IAgentRuntime;
  workers: Map<string, TaskWorker>;
  tasks: Task[];
  close: () => Promise<void>;
}

async function makeRuntime(): Promise<TestRuntimeContext> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-task-worker-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });

  const workers = new Map<string, TaskWorker>();
  const tasks: Task[] = [];
  let nextId = 1;

  const runtime = {
    agentId: 'agent-test',
    character: { settings: {} },
    db,
    getSetting: () => null,
    getService: () => null,
    registerTaskWorker(worker: TaskWorker) {
      workers.set(worker.name, worker);
    },
    getTaskWorker(name: string) {
      return workers.get(name);
    },
    async createTask(task: Task) {
      const id = `task-${nextId++}`;
      tasks.push({ ...task, id: id as Task['id'] });
      return id as Task['id'];
    },
    async getTasks(params: { tags?: string[] }) {
      if (!params?.tags?.length) return [...tasks];
      return tasks.filter((t) => params.tags?.every((tag) => t.tags?.includes(tag)));
    },
    async deleteTask(id: string) {
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx >= 0) tasks.splice(idx, 1);
    },
  } as IAgentRuntime;

  return {
    runtime,
    workers,
    tasks,
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('EmbeddedWorkflowService task workers', () => {
  test('registers workflow.run + workflow.webhook on start', async () => {
    const ctx = await makeRuntime();
    try {
      await EmbeddedWorkflowService.start(ctx.runtime);
      expect(ctx.workers.has(WORKFLOW_RUN_TASK_WORKER_NAME)).toBe(true);
      expect(ctx.workers.has(WORKFLOW_WEBHOOK_TASK_WORKER_NAME)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test('activateWorkflow creates a recurring core Task; deactivate removes it', async () => {
    const ctx = await makeRuntime();
    try {
      const service = await EmbeddedWorkflowService.start(ctx.runtime);
      const created = await service.createWorkflow({
        name: 'Sched test',
        nodes: [
          {
            id: 'sched',
            name: 'Schedule Trigger',
            type: 'workflows-nodes-base.scheduleTrigger',
            typeVersion: 1.2,
            position: [0, 0],
            parameters: { intervalMs: 5000 },
          },
          {
            id: 'set',
            name: 'Set',
            type: 'workflows-nodes-base.set',
            typeVersion: 3.4,
            position: [200, 0],
            parameters: { assignments: { assignments: [] } },
          },
        ],
        connections: {
          'Schedule Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
        },
      });

      await service.activateWorkflow(created.id);
      const scheduledTasks = ctx.tasks.filter((t) => t.name === WORKFLOW_RUN_TASK_WORKER_NAME);
      expect(scheduledTasks).toHaveLength(1);
      const task = scheduledTasks[0];
      expect(task.metadata?.workflowId).toBe(created.id);
      expect(task.metadata?.kind).toBe(WORKFLOW_TASK_KIND);
      expect(task.metadata?.updateInterval).toBe(5000);
      expect(task.tags).toContain('queue');
      expect(task.tags).toContain('repeat');
      expect(task.tags).toContain('workflow');

      await service.deactivateWorkflow(created.id);
      const after = ctx.tasks.filter((t) => t.name === WORKFLOW_RUN_TASK_WORKER_NAME);
      expect(after).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  test('workflow.run worker dispatches to executeWorkflow with the task metadata workflowId', async () => {
    const ctx = await makeRuntime();
    try {
      const service = await EmbeddedWorkflowService.start(ctx.runtime);
      const created = await service.createWorkflow({
        name: 'Worker dispatch',
        nodes: [
          {
            id: 'manual',
            name: 'Manual Trigger',
            type: 'workflows-nodes-base.manualTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
      });

      const worker = ctx.workers.get(WORKFLOW_RUN_TASK_WORKER_NAME);
      expect(worker).toBeDefined();
      const executeCalls: Array<{ workflowId: string; mode: string | undefined }> = [];
      service.executeWorkflow = (async (workflowId, options) => {
        executeCalls.push({ workflowId, mode: options.mode });
        return undefined as unknown as Awaited<ReturnType<typeof service.executeWorkflow>>;
      }) as typeof service.executeWorkflow;

      const fakeTask = {
        id: 'task-x' as Task['id'],
        name: WORKFLOW_RUN_TASK_WORKER_NAME,
        tags: ['queue', 'repeat', 'workflow'],
        metadata: { kind: WORKFLOW_TASK_KIND, workflowId: created.id },
      } as Task;

      const result = await worker?.execute(ctx.runtime, {}, fakeTask);
      expect(result).toBeUndefined();
      expect(executeCalls).toEqual([{ workflowId: created.id, mode: 'trigger' }]);
    } finally {
      await ctx.close();
    }
  });

  test('workflow.run worker throws when metadata.workflowId is missing', async () => {
    const ctx = await makeRuntime();
    try {
      await EmbeddedWorkflowService.start(ctx.runtime);
      const worker = ctx.workers.get(WORKFLOW_RUN_TASK_WORKER_NAME);
      expect(worker).toBeDefined();
      if (!worker) throw new Error('expected workflow run worker');
      const badTask = {
        id: 'task-bad' as Task['id'],
        name: WORKFLOW_RUN_TASK_WORKER_NAME,
        metadata: { kind: WORKFLOW_TASK_KIND },
      } as Task;
      await expect(worker.execute(ctx.runtime, {}, badTask)).rejects.toThrow(
        /missing metadata.workflowId/
      );
    } finally {
      await ctx.close();
    }
  });
});
