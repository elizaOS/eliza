/**
 * Persistent scheduler/workflow regression over one shared PGlite database.
 * It reproduces tenant re-key orphans, proves first-fire auto-disable with a
 * persisted notification, and restarts the database to prove startup
 * reconciliation removes an unfired orphan without crossing tenant scopes.
 */

import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRuntime,
  createCharacter,
  type Plugin,
  ServiceType,
  stringToUuid,
  type Task,
  type UUID,
} from '@elizaos/core';
// TaskService must come from the same package entry the runtime loads —
// a relative src import creates a second class identity and the
// `instanceof TaskService` readiness check always fails against it.
import { NotificationService, TaskService } from '@elizaos/core/node';
import { inArray } from 'drizzle-orm';
import { registerTriggerTaskWorker } from '../../../../packages/agent/src/triggers/runtime.ts';
import { plugin as sqlPlugin } from '../../../plugin-sql/src/index.ts';
import { DatabaseMigrationService } from '../../../plugin-sql/src/migration-service.ts';
import { PgliteDatabaseAdapter } from '../../../plugin-sql/src/pglite/adapter.ts';
import { PGliteClientManager } from '../../../plugin-sql/src/pglite/manager.ts';
import type { DrizzleDatabase } from '../../../plugin-sql/src/types.ts';
import * as dbSchema from '../../src/db/schema.ts';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  EmbeddedWorkflowService,
  WORKFLOW_TASK_KIND,
} from '../../src/services/embedded-workflow-service.ts';
import { registerWorkflowDispatchService } from '../../src/services/workflow-dispatch.ts';
import type { WorkflowDefinition } from '../../src/types/index.ts';

setDefaultTimeout(120_000);

const AGENT_A_ID = stringToUuid('workflow-orphan-reconciliation-agent-a');
const AGENT_B_ID = stringToUuid('workflow-orphan-reconciliation-agent-b');
const FIRED_ORPHAN_WORKFLOW_ID = 'fired-orphaned-tenant-a-workflow';
const RESTART_ORPHAN_WORKFLOW_ID = 'restart-orphaned-tenant-a-workflow';
const VALID_A_WORKFLOW_ID = 'valid-tenant-a-workflow';
const VALID_B_WORKFLOW_ID = 'valid-tenant-b-workflow';
const SCHEDULE_INTERVAL_MS = 60 * 60 * 1000;

interface RuntimePair {
  runtimeA: AgentRuntime;
  runtimeB: AgentRuntime;
}

type PersistentTask = Task & { id: UUID };

function workflowPluginForTest(includeNotifications: boolean): Plugin {
  return {
    name: includeNotifications
      ? 'workflow-orphan-reconciliation-with-notifications'
      : 'workflow-orphan-reconciliation',
    description: 'Persistent workflow reconciliation integration services',
    services: includeNotifications
      ? [EmbeddedWorkflowService, NotificationService]
      : [EmbeddedWorkflowService],
  };
}

function createRuntime(
  agentId: UUID,
  adapter: PgliteDatabaseAdapter,
  plugins: Plugin[] = []
): AgentRuntime {
  return Object.assign(
    new AgentRuntime({
      character: createCharacter({
        id: agentId,
        name: `WorkflowReconciliation-${agentId}`,
        settings: { WORKFLOW_SEED_DEFAULTS: 'false' },
      }),
      adapter,
      plugins,
      logLevel: 'fatal',
      enableAutonomy: false,
    }),
    { serverless: true }
  );
}

async function createRuntimePair(
  manager: PGliteClientManager,
  options: { embeddedForB: boolean }
): Promise<RuntimePair> {
  const adapterA = new PgliteDatabaseAdapter(AGENT_A_ID, manager);
  const adapterB = new PgliteDatabaseAdapter(AGENT_B_ID, manager);
  await Promise.all([adapterA.init(), adapterB.init()]);
  const runtimeA = createRuntime(AGENT_A_ID, adapterA, [workflowPluginForTest(true)]);
  const runtimeB = createRuntime(
    AGENT_B_ID,
    adapterB,
    options.embeddedForB ? [workflowPluginForTest(false)] : []
  );
  await runtimeA.initialize({ skipMigrations: true });
  await runtimeB.initialize({ skipMigrations: true });
  return { runtimeA, runtimeB };
}

async function migrateCoreTaskStore(adapter: PgliteDatabaseAdapter): Promise<void> {
  const migrations = new DatabaseMigrationService({ databaseBackend: 'pglite' });
  await migrations.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
}

function scheduledWorkflow(id: string, name: string): WorkflowDefinition {
  return {
    id,
    name,
    nodes: [
      {
        id: `${id}-schedule`,
        name: 'Schedule Trigger',
        type: 'workflows-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 0],
        parameters: { intervalMs: SCHEDULE_INTERVAL_MS },
      },
      {
        id: `${id}-set`,
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
  };
}

async function getEmbedded(runtime: AgentRuntime): Promise<EmbeddedWorkflowService> {
  const service = await runtime.getServiceLoadPromise(EMBEDDED_WORKFLOW_SERVICE_TYPE);
  if (!(service instanceof EmbeddedWorkflowService)) {
    throw new Error('Embedded workflow service did not start');
  }
  return service;
}

async function getTaskService(runtime: AgentRuntime): Promise<TaskService> {
  const service = await runtime.getServiceLoadPromise(ServiceType.TASK);
  if (!(service instanceof TaskService)) {
    throw new Error('Task service did not start');
  }
  return service;
}

async function getNotificationService(runtime: AgentRuntime): Promise<NotificationService> {
  const service = await runtime.getServiceLoadPromise(ServiceType.NOTIFICATION);
  if (!(service instanceof NotificationService)) {
    throw new Error('Notification service did not start');
  }
  return service;
}

async function workflowTasks(runtime: AgentRuntime): Promise<Task[]> {
  return runtime.getTasks({ tags: ['workflow'] });
}

function taskForWorkflow(tasks: Task[], workflowId: string): PersistentTask {
  const task = tasks.find((candidate) => candidate.metadata?.workflowId === workflowId);
  if (!task?.id) {
    throw new Error(`Persistent schedule task missing for workflow ${workflowId}`);
  }
  return { ...task, id: task.id };
}

async function makeTaskDue(runtime: AgentRuntime, task: Task): Promise<void> {
  if (!task.id || !task.metadata?.trigger) {
    throw new Error('Workflow schedule task is missing its id or trigger metadata');
  }
  await runtime.updateTask(task.id, {
    metadata: {
      ...task.metadata,
      updatedAt: 0,
      trigger: { ...task.metadata.trigger, nextRunAtMs: 0 },
    },
  });
}

async function waitForPersistedDisabledNotification(runtime: AgentRuntime): Promise<void> {
  const cacheKey = `notifications:${runtime.agentId}`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const notifications = await runtime.getCache<Array<{ title?: string }>>(cacheKey);
    if (notifications?.some((notification) => notification.title?.includes('disabled'))) return;
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the real disabled notification to persist');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function stopPair(pair: RuntimePair): Promise<void> {
  await Promise.all([pair.runtimeA.stop(), pair.runtimeB.stop()]);
}

test('first fire disables one orphan and restart quarantines another without crossing tenants', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'workflow-orphan-reconciliation-'));
  const dataDir = join(tempDir, 'pglite');
  let manager: PGliteClientManager | null = new PGliteClientManager({ dataDir });
  let activePair: RuntimePair | null = null;

  try {
    await manager.initialize();
    const migrationAdapter = new PgliteDatabaseAdapter(AGENT_A_ID, manager);
    await migrationAdapter.init();
    await migrateCoreTaskStore(migrationAdapter);

    activePair = await createRuntimePair(manager, { embeddedForB: true });
    const firstPair = activePair;
    const workflowA = await getEmbedded(firstPair.runtimeA);
    const workflowB = await getEmbedded(firstPair.runtimeB);
    const notificationsA = await getNotificationService(firstPair.runtimeA);
    const taskServiceA = await getTaskService(firstPair.runtimeA);
    registerWorkflowDispatchService(firstPair.runtimeA);
    registerTriggerTaskWorker(firstPair.runtimeA);

    for (const definition of [
      scheduledWorkflow(FIRED_ORPHAN_WORKFLOW_ID, 'Tenant A fired orphan'),
      scheduledWorkflow(RESTART_ORPHAN_WORKFLOW_ID, 'Tenant A restart orphan'),
      scheduledWorkflow(VALID_A_WORKFLOW_ID, 'Tenant A valid'),
    ]) {
      const created = await workflowA.createWorkflow(definition);
      await workflowA.activateWorkflow(created.id);
    }
    const validB = scheduledWorkflow(VALID_B_WORKFLOW_ID, 'Tenant B valid');
    const createdB = await workflowB.createWorkflow(validB);
    await workflowB.activateWorkflow(createdB.id);

    const initialTasksA = await workflowTasks(firstPair.runtimeA);
    const initialTasksB = await workflowTasks(firstPair.runtimeB);
    expect(initialTasksA).toHaveLength(3);
    expect(initialTasksB).toHaveLength(1);
    const firedOrphanTask = taskForWorkflow(initialTasksA, FIRED_ORPHAN_WORKFLOW_ID);
    const restartOrphanTask = taskForWorkflow(initialTasksA, RESTART_ORPHAN_WORKFLOW_ID);
    const validBTask = taskForWorkflow(initialTasksB, VALID_B_WORKFLOW_ID);

    const workflowDb = firstPair.runtimeA.db as DrizzleDatabase;
    await workflowDb
      .update(dbSchema.embeddedWorkflows)
      .set({ agentId: dbSchema.LEGACY_UNSCOPED_WORKFLOW_AGENT_ID })
      .where(
        inArray(dbSchema.embeddedWorkflows.id, [
          FIRED_ORPHAN_WORKFLOW_ID,
          RESTART_ORPHAN_WORKFLOW_ID,
        ])
      );

    await makeTaskDue(firstPair.runtimeA, firedOrphanTask);
    await taskServiceA.runDueTasks();
    // A workflow_not_found dispatch is permanent: the fired orphan sends one
    // disabled notification and is deleted immediately. The second orphan is
    // intentionally left unfired so restart reconciliation still has work.
    await waitForPersistedDisabledNotification(firstPair.runtimeA);
    const disabledNotifications = notificationsA.list({ category: 'workflow' });
    expect(disabledNotifications).toHaveLength(1);
    expect(disabledNotifications[0]?.title).toContain('disabled');
    expect(await firstPair.runtimeA.getTask(firedOrphanTask.id)).toBeNull();
    expect(await firstPair.runtimeA.getTask(restartOrphanTask.id)).not.toBeNull();

    await stopPair(firstPair);
    activePair = null;
    await manager.close();
    manager = null;

    manager = new PGliteClientManager({ dataDir });
    await manager.initialize();
    activePair = await createRuntimePair(manager, { embeddedForB: false });
    const restartedPair = activePair;
    const restartedWorkflowA = await getEmbedded(restartedPair.runtimeA);
    const restartedNotificationsA = await getNotificationService(restartedPair.runtimeA);
    const restartedTaskServiceA = await getTaskService(restartedPair.runtimeA);
    registerWorkflowDispatchService(restartedPair.runtimeA);
    registerTriggerTaskWorker(restartedPair.runtimeA);

    const restartedTasksA = await workflowTasks(restartedPair.runtimeA);
    const restartedTasksB = await workflowTasks(restartedPair.runtimeB);
    expect(restartedTasksA).toHaveLength(1);
    expect(restartedTasksA[0]?.metadata?.kind).toBe(WORKFLOW_TASK_KIND);
    expect(restartedTasksA[0]?.metadata?.workflowId).toBe(VALID_A_WORKFLOW_ID);
    expect(restartedTasksB).toHaveLength(1);
    expect(restartedTasksB[0]?.id).toBe(validBTask.id);
    expect(restartedTasksB[0]?.metadata?.workflowId).toBe(VALID_B_WORKFLOW_ID);
    expect(await restartedPair.runtimeA.getTask(firedOrphanTask.id)).toBeNull();
    expect(await restartedPair.runtimeA.getTask(restartOrphanTask.id)).toBeNull();

    const workflowRows = await (restartedPair.runtimeA.db as DrizzleDatabase)
      .select({
        agentId: dbSchema.embeddedWorkflows.agentId,
        id: dbSchema.embeddedWorkflows.id,
        active: dbSchema.embeddedWorkflows.active,
      })
      .from(dbSchema.embeddedWorkflows);
    expect(workflowRows).toEqual(
      expect.arrayContaining([
        {
          agentId: dbSchema.LEGACY_UNSCOPED_WORKFLOW_AGENT_ID,
          id: FIRED_ORPHAN_WORKFLOW_ID,
          active: true,
        },
        {
          agentId: dbSchema.LEGACY_UNSCOPED_WORKFLOW_AGENT_ID,
          id: RESTART_ORPHAN_WORKFLOW_ID,
          active: true,
        },
        { agentId: AGENT_A_ID, id: VALID_A_WORKFLOW_ID, active: true },
        { agentId: AGENT_B_ID, id: VALID_B_WORKFLOW_ID, active: true },
      ])
    );

    const notificationsBeforeTick = restartedNotificationsA.list({ category: 'workflow' });
    const executionsBeforeTick = await restartedWorkflowA.listExecutions();
    await restartedTaskServiceA.runDueTasks();
    expect(restartedNotificationsA.list({ category: 'workflow' })).toEqual(notificationsBeforeTick);
    expect(await restartedWorkflowA.listExecutions()).toEqual(executionsBeforeTick);
    expect(await restartedPair.runtimeA.getTask(firedOrphanTask.id)).toBeNull();
    expect(await restartedPair.runtimeA.getTask(restartOrphanTask.id)).toBeNull();
    expect((await workflowTasks(restartedPair.runtimeB))[0]?.id).toBe(validBTask.id);
  } finally {
    try {
      if (activePair) await stopPair(activePair);
    } finally {
      try {
        if (manager) await manager.close();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }
});
