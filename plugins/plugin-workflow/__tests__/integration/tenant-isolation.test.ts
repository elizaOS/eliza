/**
 * Adversarial tenant-isolation coverage against one real PGlite database.
 * Two AgentRuntime-shaped services share storage without sharing domain rows.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { type IAgentRuntime, stringToUuid, type Task, type UUID } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import * as dbSchema from '../../src/db/schema';
import { LEGACY_UNSCOPED_WORKFLOW_AGENT_ID } from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WorkflowCredentialStore } from '../../src/services/workflow-credential-store';
import type { WorkflowDefinition } from '../../src/types/index';
import { getUserTagName } from '../../src/utils/context';

setDefaultTimeout(120_000);

interface StoredTask extends Task {
  agentId: UUID;
}

interface SharedHarness {
  client: PGlite;
  db: ReturnType<typeof drizzle<typeof dbSchema>>;
  tasks: StoredTask[];
  runtimeA: IAgentRuntime;
  runtimeB: IAgentRuntime;
  close(): Promise<void>;
}

const openHarnesses: SharedHarness[] = [];

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

async function makeSharedHarness(): Promise<SharedHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-tenant-isolation-'));
  const client = new PGlite({ dataDir: join(dir, 'pglite') });
  const db = drizzle(client, { schema: dbSchema });
  const tasks: StoredTask[] = [];
  let taskSequence = 0;

  const buildRuntime = (agentSeed: string): IAgentRuntime => {
    const agentId = stringToUuid(agentSeed);
    return {
      agentId,
      character: { settings: {} },
      db,
      getSetting: (key: string) => (key === 'WORKFLOW_SEED_DEFAULTS' ? false : null),
      getService: () => null,
      getEntityById: async () => null,
      registerEvent: () => {},
      unregisterEvent: () => {},
      createTask: async (task: Task) => {
        taskSequence += 1;
        const id = stringToUuid(`${agentId}:workflow-task:${taskSequence}`);
        tasks.push({ ...task, id, agentId });
        return id;
      },
      getTasks: async (params: { tags?: string[]; agentIds?: UUID[] }) =>
        tasks.filter(
          (task) =>
            (!params.agentIds?.length || params.agentIds.includes(task.agentId)) &&
            (!params.tags?.length || params.tags.every((tag) => task.tags?.includes(tag)))
        ),
      deleteTask: async (id: UUID) => {
        const index = tasks.findIndex((task) => task.id === id && task.agentId === agentId);
        if (index >= 0) tasks.splice(index, 1);
      },
    } as IAgentRuntime;
  };

  let closed = false;
  const harness: SharedHarness = {
    client,
    db,
    tasks,
    runtimeA: buildRuntime('workflow-tenant-agent-a'),
    runtimeB: buildRuntime('workflow-tenant-agent-b'),
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  openHarnesses.push(harness);
  return harness;
}

function manualWorkflow(id: string, name: string, tenant: string): WorkflowDefinition {
  return {
    id,
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
        name: 'Set',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [200, 0],
        parameters: {
          assignments: { assignments: [{ name: 'tenant', value: tenant }] },
        },
      },
    ],
    connections: {
      'Manual Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
    },
  };
}

function scheduledWorkflow(id: string): WorkflowDefinition {
  return {
    id,
    name: 'Agent A schedule',
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
        name: 'Set',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [200, 0],
        parameters: { assignments: { assignments: [{ name: 'scheduled', value: true }] } },
      },
    ],
    connections: {
      'Schedule Trigger': { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
    },
  };
}

function webhookWorkflow(id: string): WorkflowDefinition {
  return {
    id,
    name: 'Agent A webhook',
    nodes: [
      {
        id: 'webhook',
        name: 'Webhook',
        type: 'workflows-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 0],
        parameters: { path: 'agent-a-only', httpMethod: 'POST' },
      },
      {
        id: 'set',
        name: 'Set',
        type: 'workflows-nodes-base.set',
        typeVersion: 3.4,
        position: [200, 0],
        parameters: { assignments: { assignments: [{ name: 'handledBy', value: 'agent-a' }] } },
      },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
    },
  };
}

describe('EmbeddedWorkflowService tenant isolation', () => {
  test('serializes the first tenant migration and keeps migrated startups on the SELECT-only path', async () => {
    const harness = await makeSharedHarness();
    await Promise.all([
      EmbeddedWorkflowService.start(harness.runtimeA),
      EmbeddedWorkflowService.start(harness.runtimeB),
    ]);

    const database = harness.db;
    let transactionCalls = 0;
    const migratedDb = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (...args: Parameters<typeof database.transaction>) => {
            transactionCalls += 1;
            return database.transaction(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Reflect.set(harness.runtimeB, 'db', migratedDb);

    await EmbeddedWorkflowService.start(harness.runtimeB);
    expect(transactionCalls).toBe(0);
  });

  test('isolates CRUD, revisions, Smithers runs, schedules, webhooks, tags, and credentials', async () => {
    const harness = await makeSharedHarness();
    const serviceA = await EmbeddedWorkflowService.start(harness.runtimeA);
    const serviceB = await EmbeddedWorkflowService.start(harness.runtimeB);
    const credentialsA = await WorkflowCredentialStore.start(harness.runtimeA);
    const credentialsB = await WorkflowCredentialStore.start(harness.runtimeB);

    const sharedId = 'system-device-health-check';
    await serviceA.createWorkflow(manualWorkflow(sharedId, 'Agent A default', 'agent-a'));
    await serviceB.createWorkflow(manualWorkflow(sharedId, 'Agent B default', 'agent-b'));

    expect((await serviceA.getWorkflow(sharedId)).name).toBe('Agent A default');
    expect((await serviceB.getWorkflow(sharedId)).name).toBe('Agent B default');
    expect((await serviceA.listWorkflows()).data.map((workflow) => workflow.name)).toEqual([
      'Agent A default',
    ]);
    expect((await serviceB.listWorkflows()).data.map((workflow) => workflow.name)).toEqual([
      'Agent B default',
    ]);

    await serviceA.updateWorkflow(
      sharedId,
      manualWorkflow(sharedId, 'Agent A default revised', 'agent-a-revised')
    );
    const revisionsA = await serviceA.listWorkflowRevisions(sharedId);
    expect(revisionsA.data).toHaveLength(1);
    expect((await serviceB.listWorkflowRevisions(sharedId)).data).toHaveLength(0);
    await expect(
      serviceB.restoreWorkflowRevision(sharedId, revisionsA.data[0].versionId)
    ).rejects.toThrow('Workflow revision not found');
    expect((await serviceB.getWorkflow(sharedId)).name).toBe('Agent B default');

    const executionA = await serviceA.executeWorkflow(sharedId, {
      idempotencyKey: 'same-dispatch-key',
    });
    const executionB = await serviceB.executeWorkflow(sharedId, {
      idempotencyKey: 'same-dispatch-key',
    });
    expect(executionA.status).toBe('success');
    expect(executionB.status).toBe('success');
    expect(
      await serviceA.findExecutionByIdempotencyKey(sharedId, 'same-dispatch-key')
    ).toMatchObject({ id: executionA.id });
    expect(
      await serviceB.findExecutionByIdempotencyKey(sharedId, 'same-dispatch-key')
    ).toMatchObject({ id: executionB.id });
    await expect(serviceB.getExecution(executionA.id)).rejects.toThrow('Execution not found');
    await serviceB.deleteExecution(executionA.id);
    expect((await serviceA.getExecution(executionA.id)).id).toBe(executionA.id);
    expect((await serviceA.listExecutions({ workflowId: sharedId })).data).toHaveLength(1);
    expect((await serviceB.listExecutions({ workflowId: sharedId })).data).toHaveLength(1);

    const agentAOnlyId = 'agent-a-only';
    await serviceA.createWorkflow(manualWorkflow(agentAOnlyId, 'Agent A only', 'agent-a'));
    await expect(serviceB.getWorkflow(agentAOnlyId)).rejects.toThrow('Workflow not found');
    await expect(serviceB.executeWorkflow(agentAOnlyId)).rejects.toThrow('Workflow not found');
    await expect(
      serviceB.updateWorkflow(agentAOnlyId, manualWorkflow(agentAOnlyId, 'Stolen', 'agent-b'))
    ).rejects.toThrow('Workflow not found');
    await expect(serviceB.deleteWorkflow(agentAOnlyId)).rejects.toThrow('Workflow not found');
    expect((await serviceA.getWorkflow(agentAOnlyId)).name).toBe('Agent A only');

    const scheduleId = 'agent-a-schedule';
    await serviceA.createWorkflow(scheduledWorkflow(scheduleId));
    await serviceA.activateWorkflow(scheduleId);
    expect(harness.tasks.filter((task) => task.agentId === harness.runtimeA.agentId)).toHaveLength(
      1
    );
    expect(harness.tasks.filter((task) => task.agentId === harness.runtimeB.agentId)).toHaveLength(
      0
    );
    await EmbeddedWorkflowService.start(harness.runtimeB);
    expect(harness.tasks.filter((task) => task.agentId === harness.runtimeB.agentId)).toHaveLength(
      0
    );
    await expect(serviceB.triggerSchedulesOnce(scheduleId)).rejects.toThrow('Workflow not found');

    const webhookId = 'agent-a-webhook';
    await serviceA.createWorkflow(webhookWorkflow(webhookId));
    await serviceA.activateWorkflow(webhookId);
    await expect(
      serviceB.executeWebhook('agent-a-only', { secret: 'cross-tenant' }, 'POST')
    ).rejects.toThrow('Webhook not found');
    const webhookExecution = await serviceA.executeWebhook(
      'agent-a-only',
      { visible: 'agent-a' },
      'POST'
    );
    expect(webhookExecution.status).toBe('success');

    const tagA = await serviceA.getOrCreateTag('owner');
    const tagB = await serviceB.getOrCreateTag('owner');
    expect(tagA.id).not.toBe(tagB.id);
    expect((await serviceA.listTags()).data).toEqual([tagA]);
    expect((await serviceB.listTags()).data).toEqual([tagB]);
    await expect(serviceB.updateWorkflowTags(sharedId, [tagA.id])).rejects.toThrow('Tag not found');
    await serviceA.updateWorkflowTags(sharedId, [tagA.id]);

    const embeddedCredentialA = await serviceA.createCredential({
      name: 'Agent A token',
      type: 'apiToken',
      data: { secret: 'agent-a-secret' },
    });
    await serviceB.createCredential({
      name: 'Agent B token',
      type: 'apiToken',
      data: { secret: 'agent-b-secret' },
    });
    await serviceB.deleteCredential(embeddedCredentialA.id);
    const retainedCredentialA = await harness.db
      .select({ agentId: dbSchema.embeddedCredentials.agentId })
      .from(dbSchema.embeddedCredentials)
      .where(
        and(
          eq(dbSchema.embeddedCredentials.agentId, harness.runtimeA.agentId),
          eq(dbSchema.embeddedCredentials.id, embeddedCredentialA.id)
        )
      );
    expect(retainedCredentialA).toEqual([{ agentId: harness.runtimeA.agentId }]);

    const userId = stringToUuid('same-workflow-user');
    await credentialsA.set(userId, 'apiToken', embeddedCredentialA.id);
    await credentialsB.set(userId, 'apiToken', 'agent-b-credential');
    expect(await credentialsA.get(userId, 'apiToken')).toBe(embeddedCredentialA.id);
    expect(await credentialsB.get(userId, 'apiToken')).toBe('agent-b-credential');
    await credentialsB.delete(userId, 'apiToken');
    expect(await credentialsA.get(userId, 'apiToken')).toBe(embeddedCredentialA.id);
    expect(await credentialsB.get(userId, 'apiToken')).toBeNull();

    expect(await getUserTagName(harness.runtimeA, userId)).not.toBe(
      await getUserTagName(harness.runtimeB, userId)
    );

    await credentialsA.stop();
    await credentialsB.stop();
    await serviceA.stop();
    await serviceB.stop();
  });

  test('quarantines legacy unscoped rows and never schedules, exposes, or auto-claims them', async () => {
    const harness = await makeSharedHarness();
    await createLegacyUnscopedRows(harness.client);

    const serviceA = await EmbeddedWorkflowService.start(harness.runtimeA);
    const serviceB = await EmbeddedWorkflowService.start(harness.runtimeB);
    const credentialsA = await WorkflowCredentialStore.start(harness.runtimeA);
    const credentialsB = await WorkflowCredentialStore.start(harness.runtimeB);

    expect((await serviceA.listWorkflows()).data).toHaveLength(0);
    expect((await serviceB.listWorkflows()).data).toHaveLength(0);
    expect((await serviceA.listWorkflowRevisions('legacy-workflow')).data).toHaveLength(0);
    expect((await serviceA.listExecutions()).data).toHaveLength(0);
    expect((await serviceA.listTags()).data).toHaveLength(0);
    expect(await credentialsA.get('legacy-user', 'apiToken')).toBeNull();
    expect(await credentialsB.get('legacy-user', 'apiToken')).toBeNull();
    expect(harness.tasks).toHaveLength(0);
    await expect(serviceA.getWorkflow('legacy-workflow')).rejects.toThrow('Workflow not found');
    await expect(serviceA.executeWorkflow('legacy-workflow')).rejects.toThrow('Workflow not found');
    await expect(
      serviceA.executeWebhook('legacy-hook', { attempt: 'claim' }, 'POST')
    ).rejects.toThrow('Webhook not found');

    const migratedTables = [
      dbSchema.credentialMappings,
      dbSchema.embeddedWorkflows,
      dbSchema.workflowRevisions,
      dbSchema.embeddedExecutions,
      dbSchema.embeddedCredentials,
      dbSchema.embeddedTags,
    ] as const;
    for (const table of migratedTables) {
      const rows = await harness.db.select({ agentId: table.agentId }).from(table);
      expect(rows).toContainEqual({ agentId: LEGACY_UNSCOPED_WORKFLOW_AGENT_ID });
    }

    await serviceA.createWorkflow(
      manualWorkflow('legacy-workflow', 'Agent A replacement', 'agent-a')
    );
    await serviceB.createWorkflow(
      manualWorkflow('legacy-workflow', 'Agent B replacement', 'agent-b')
    );
    expect((await serviceA.getWorkflow('legacy-workflow')).name).toBe('Agent A replacement');
    expect((await serviceB.getWorkflow('legacy-workflow')).name).toBe('Agent B replacement');

    const physicalRows = await harness.db
      .select({ agentId: dbSchema.embeddedWorkflows.agentId })
      .from(dbSchema.embeddedWorkflows)
      .where(eq(dbSchema.embeddedWorkflows.id, 'legacy-workflow'));
    expect(new Set(physicalRows.map((row) => row.agentId))).toEqual(
      new Set([
        LEGACY_UNSCOPED_WORKFLOW_AGENT_ID,
        harness.runtimeA.agentId,
        harness.runtimeB.agentId,
      ])
    );

    await credentialsA.stop();
    await credentialsB.stop();
    await serviceA.stop();
    await serviceB.stop();
  });
});

async function createLegacyUnscopedRows(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE SCHEMA "workflow";
    CREATE TABLE "workflow"."credential_mappings" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" text NOT NULL,
      "cred_type" text NOT NULL,
      "workflow_credential_id" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE UNIQUE INDEX "idx_user_cred"
      ON "workflow"."credential_mappings" ("user_id", "cred_type");
    CREATE TABLE "workflow"."embedded_workflows" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "active" boolean DEFAULT false NOT NULL,
      "workflow" jsonb NOT NULL,
      "created_at" text NOT NULL,
      "updated_at" text NOT NULL,
      "version_id" text NOT NULL
    );
    CREATE TABLE "workflow"."workflow_revisions" (
      "id" text PRIMARY KEY,
      "workflow_id" text NOT NULL,
      "version_id" text NOT NULL,
      "name" text NOT NULL,
      "active" boolean DEFAULT false NOT NULL,
      "workflow" jsonb NOT NULL,
      "created_at" text NOT NULL,
      "updated_at" text NOT NULL,
      "captured_at" text NOT NULL,
      "operation" text NOT NULL
    );
    CREATE UNIQUE INDEX "idx_workflow_revisions_workflow_version"
      ON "workflow"."workflow_revisions" ("workflow_id", "version_id");
    CREATE TABLE "workflow"."embedded_executions" (
      "id" text PRIMARY KEY,
      "workflow_id" text NOT NULL,
      "status" text NOT NULL,
      "mode" text NOT NULL,
      "finished" boolean DEFAULT false NOT NULL,
      "started_at" text NOT NULL,
      "stopped_at" text,
      "execution" jsonb NOT NULL
    );
    CREATE TABLE "workflow"."embedded_credentials" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "type" text NOT NULL,
      "data" jsonb NOT NULL,
      "is_resolvable" boolean DEFAULT true NOT NULL,
      "created_at" text NOT NULL,
      "updated_at" text NOT NULL
    );
    CREATE TABLE "workflow"."embedded_tags" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "created_at" text NOT NULL,
      "updated_at" text NOT NULL
    );
    CREATE UNIQUE INDEX "idx_embedded_tags_name" ON "workflow"."embedded_tags" ("name");
  `);

  const timestamp = new Date(0).toISOString();
  const legacyWorkflow = {
    ...scheduledWorkflow('legacy-workflow'),
    active: true,
    nodes: [
      ...scheduledWorkflow('legacy-workflow').nodes,
      {
        id: 'webhook',
        name: 'Webhook',
        type: 'workflows-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 200],
        parameters: { path: 'legacy-hook', httpMethod: 'POST' },
      },
    ],
  };
  const legacyExecution = {
    id: 'legacy-execution',
    workflowId: 'legacy-workflow',
    status: 'success',
    mode: 'manual',
    finished: true,
    startedAt: timestamp,
    stoppedAt: timestamp,
  };
  await client.query(
    `INSERT INTO "workflow"."credential_mappings"
      ("user_id", "cred_type", "workflow_credential_id") VALUES ($1, $2, $3)`,
    ['legacy-user', 'apiToken', 'legacy-credential']
  );
  await client.query(
    `INSERT INTO "workflow"."embedded_workflows"
      ("id", "name", "active", "workflow", "created_at", "updated_at", "version_id")
      VALUES ($1, $2, true, $3::jsonb, $4, $4, $5)`,
    ['legacy-workflow', 'Legacy workflow', JSON.stringify(legacyWorkflow), timestamp, 'legacy-v1']
  );
  await client.query(
    `INSERT INTO "workflow"."workflow_revisions"
      ("id", "workflow_id", "version_id", "name", "active", "workflow", "created_at", "updated_at", "captured_at", "operation")
      VALUES ($1, $2, $3, $4, true, $5::jsonb, $6, $6, $6, 'update')`,
    [
      'legacy-revision',
      'legacy-workflow',
      'legacy-v1',
      'Legacy workflow',
      JSON.stringify(legacyWorkflow),
      timestamp,
    ]
  );
  await client.query(
    `INSERT INTO "workflow"."embedded_executions"
      ("id", "workflow_id", "status", "mode", "finished", "started_at", "stopped_at", "execution")
      VALUES ($1, $2, 'success', 'manual', true, $3, $3, $4::jsonb)`,
    ['legacy-execution', 'legacy-workflow', timestamp, JSON.stringify(legacyExecution)]
  );
  await client.query(
    `INSERT INTO "workflow"."embedded_credentials"
      ("id", "name", "type", "data", "is_resolvable", "created_at", "updated_at")
      VALUES ($1, $2, $3, $4::jsonb, true, $5, $5)`,
    [
      'legacy-credential',
      'Legacy token',
      'apiToken',
      JSON.stringify({ secret: 'legacy' }),
      timestamp,
    ]
  );
  await client.query(
    `INSERT INTO "workflow"."embedded_tags" ("id", "name", "created_at", "updated_at")
      VALUES ($1, $2, $3, $3)`,
    ['legacy-tag', 'owner', timestamp]
  );
}
