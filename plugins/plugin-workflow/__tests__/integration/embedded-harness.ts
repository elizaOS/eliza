/**
 * Shared PGlite-backed runtime harness for workflow integration e2e suites.
 *
 * Mirrors the harness pattern established in trigger-dispatch-e2e.test.ts: a
 * runtime whose DB is a real PGlite instance and whose services registry is a
 * real map, with the REAL EmbeddedWorkflowService started against it. The only
 * test double is the runtime's task STORE (an in-memory map — same as
 * workflow-task-worker.test.ts). Callers register whatever additional real
 * services their suite drives (WORKFLOW_DISPATCH, WorkflowService, …) on the
 * exposed `services` map.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime, Task, TaskWorker, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';

export interface EmbeddedHarness {
  runtime: IAgentRuntime;
  agentId: UUID;
  tasks: Map<UUID, Task>;
  /** The runtime's real service registry, exposed so suites can register the
   * additional real services they exercise. */
  services: Map<string, unknown[]>;
  workflow: EmbeddedWorkflowService;
  close: () => Promise<void>;
}

export async function makeEmbeddedHarness(agentSeed: string): Promise<EmbeddedHarness> {
  const agentId = stringToUuid(agentSeed);
  const dir = await mkdtemp(join(tmpdir(), 'workflow-e2e-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });

  const tasks = new Map<UUID, Task>();
  const workers = new Map<string, TaskWorker>();
  const services = new Map<string, unknown[]>();
  let nextId = 1;

  const runtime = {
    agentId,
    character: { settings: {} },
    db,
    serverless: true, // no scheduler loop; suites drive execution explicitly
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    services,
    getSetting: () => null,
    getService: (type: string) => {
      const entries = services.get(type);
      return entries && entries.length > 0 ? entries[0] : null;
    },
    registerTaskWorker: (worker: TaskWorker) => {
      workers.set(worker.name, worker);
    },
    getTaskWorker: (name: string) => workers.get(name),
    createTask: async (task: Task) => {
      const id = (task.id ?? stringToUuid(`${agentSeed}-task-${nextId++}`)) as UUID;
      tasks.set(id, { ...task, id, agentId });
      return id;
    },
    getTask: async (id: UUID) => tasks.get(id) ?? null,
    getTasks: async (params: { tags?: string[] }) => {
      const wanted = params?.tags ?? [];
      return [...tasks.values()].filter((t) => wanted.every((tag) => t.tags?.includes(tag)));
    },
    getTasksByName: async (name: string) => [...tasks.values()].filter((t) => t.name === name),
    updateTask: async (id: UUID, patch: Partial<Task>) => {
      const existing = tasks.get(id);
      if (existing) tasks.set(id, { ...existing, ...patch });
    },
    deleteTask: async (id: UUID) => {
      tasks.delete(id);
    },
  } as unknown as IAgentRuntime;

  const workflow = await EmbeddedWorkflowService.start(runtime);
  services.set(EMBEDDED_WORKFLOW_SERVICE_TYPE, [workflow]);

  return {
    runtime,
    agentId,
    tasks,
    services,
    workflow,
    async close() {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
