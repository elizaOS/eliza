import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WorkflowService } from '../../src/services/workflow-service';

test('HTTP lifecycle remove/restore: retained history, blocked admissions, pending cleanup restart and immutable receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-submission-'));
  let db = new PGlite(directory);
  let server: http.Server | undefined;
  const tasks = new Map<string, any>();
  let failCleanup = false;
  let taskReads = 0;
  let embedded: EmbeddedWorkflowService | undefined;
  try {
    await db.exec(`
    CREATE SCHEMA workflow;
    CREATE TABLE workflow.embedded_workflows (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      version_id text NOT NULL,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE workflow.workflow_revisions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      version_id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      captured_at text NOT NULL,
      operation text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, workflow_id, version_id)
    );
    CREATE TABLE workflow.embedded_executions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      status text NOT NULL,
      mode text NOT NULL,
      finished boolean NOT NULL DEFAULT false,
      started_at text NOT NULL,
      stopped_at text,
      execution jsonb NOT NULL,
      idempotency_key text,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE workflow.embedded_tags (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, name)
    );

 CREATE TABLE workflow.lifecycle_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,operation text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
 CREATE TABLE workflow.metadata_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,name text NOT NULL,description text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
 CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`);
    let runtime: any;
    const boot = async () => {
      runtime = {
        agentId: '00000000-0000-4000-8000-000000000001',
        db: drizzle(db, { schema }),
        getTasks: async () => {
          taskReads++;
          return [...tasks.values()];
        },
        deleteTask: async (id: string) => {
          if (failCleanup) throw Error('Synthetic task store unavailable');
          tasks.delete(id);
        },
        createTask: async (task: any) => {
          const id = randomUUID();
          tasks.set(id, { ...task, id });
          return id;
        },
        emitEvent: async () => {},
        getService: (name: string) => (name === 'embedded_workflow_service' ? embedded : facade),
      };
      embedded = await EmbeddedWorkflowService.start(runtime);
      const facade = new WorkflowService(runtime);
      server = http.createServer((req, res) => {
        void handleWorkflowRoutes({
          req,
          res,
          method: req.method!,
          pathname: new URL(req.url!, 'http://localhost').pathname,
          runtime,
          principalId: req.headers['x-fixture-owner'] === 'other' ? 'other' : 'owner',
          json: (response, body, status = 200) => {
            if (req.headers['x-fixture-drop'] === '1' && status === 200) {
              response.destroy();
              return;
            }
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
          },
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as any).port}/api/workflow`;
    };
    let origin = await boot();
    const call = async (path: string, body?: unknown, owner = 'owner') => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-owner': owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const definition = {
      name: 'Lifecycle fixture',
      description: 'Retained source',
      language: 'tsx',
      active: false,
      metadata: { elizaOwnerEntityId: 'owner' },
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';const {Workflow,Task,smithers,outputs}=createSmithers({answer:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});export default smithers(()=><Workflow name="lifecycle"><Task id="answer" output={outputs.answer}>{{value:56}}</Task></Workflow>);`,
    };
    const held = await embedded!.createWorkflow({
      ...definition,
      name: 'Held lifecycle fixture',
      source: definition.source.replace(
        'export default',
        'await new Promise(resolve=>setTimeout(resolve,180000));export default'
      ),
    } as any);
    const admitted = await call(`/workflows/${held.id}/run`, {
      submissionId: randomUUID(),
      expectedVersionId: held.versionId,
      input: {},
    });
    expect(admitted.status).toBe(202);
    const refused = await call(`/workflows/${held.id}/lifecycle`, {
      mutationId: randomUUID(),
      expectedVersionId: held.versionId,
      operation: 'remove',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('WORKFLOW_LIFECYCLE_NOT_APPLIED');
    expect((await call(`/workflows/${held.id}`)).body.removed).toBe(false);
    expect((await call(`/executions/${admitted.body.execution.id}/cancel`, {})).status).toBe(202);
    for (let i = 0; i < 100; i++) {
      if ((await call(`/executions/${admitted.body.execution.id}`)).body.execution.finished) break;
      await Bun.sleep(50);
    }
    const heldRemoval = {
      mutationId: randomUUID(),
      expectedVersionId: held.versionId,
      operation: 'remove',
    };
    const duplicates = await Promise.all(
      Array.from({ length: 6 }, () => call(`/workflows/${held.id}/lifecycle`, heldRemoval))
    );
    expect(duplicates.every((r) => r.status === 200)).toBe(true);
    expect(new Set(duplicates.map((r) => r.body.receipt.versionId)).size).toBe(1);
    expect((await call(`/workflows/${held.id}/revisions`)).body.revisions).toHaveLength(1);
    expect((await call(`/executions/${admitted.body.execution.id}`)).body.execution.status).toBe(
      'cancelled'
    );
    const workflow = await embedded!.createWorkflow(definition as any);
    const started = await call(`/workflows/${workflow.id}/run`, {
      submissionId: randomUUID(),
      expectedVersionId: workflow.versionId,
      input: {},
    });
    expect(started.status).toBe(202);
    const runId = started.body.execution.id;
    for (let i = 0; i < 100; i++) {
      const r = (await call('/executions/' + runId)).body.execution;
      if (r.finished) break;
      await Bun.sleep(100);
    }
    expect((await call('/executions/' + runId)).body.execution.status).toBe('finished');
    const taskId = randomUUID(),
      otherTask = randomUUID();
    tasks.set(taskId, {
      id: taskId,
      metadata: { trigger: { kind: 'workflow', workflowId: workflow.id } },
    });
    tasks.set(otherTask, {
      id: otherTask,
      metadata: { trigger: { kind: 'workflow', workflowId: 'unrelated' } },
    });
    failCleanup = true;
    const mutationId = randomUUID(),
      body = { mutationId, expectedVersionId: workflow.versionId, operation: 'remove' },
      route = `/workflows/${workflow.id}/lifecycle`;
    expect((await call(route, body, 'other')).status).toBe(404);
    const removed = await call(route, body);
    expect(removed.status).toBe(200);
    expect(removed.body.state).toMatchObject({ removed: true, cleanup: 'pending' });
    const removeReceipt = removed.body.receipt;
    expect((await call('/workflows')).body.workflows.some((w: any) => w.id === workflow.id)).toBe(
      false
    );
    expect(
      (await call('/removed-workflows')).body.workflows.some((w: any) => w.id === workflow.id)
    ).toBe(true);
    expect((await call('/executions/' + runId)).status).toBe(200);
    expect((await call('/executions/' + runId, undefined, 'other')).status).toBe(404);
    expect((await call(`/workflows/${workflow.id}/run`, { input: {} })).status).toBe(409);
    expect(
      (
        await call(`/workflows/${workflow.id}/run`, {
          submissionId: randomUUID(),
          expectedVersionId: removeReceipt.versionId,
          input: {},
        })
      ).status
    ).toBe(409);
    expect((await call(`/workflows/${workflow.id}/activate`, {})).status).toBe(409);
    await expect(embedded!.updateWorkflow(workflow.id, definition as any)).rejects.toThrow();
    expect(
      (
        await call(`/workflows/${workflow.id}/metadata`, {
          mutationId: randomUUID(),
          expectedVersionId: removeReceipt.versionId,
          name: 'Cannot revive',
          description: '',
        })
      ).status
    ).toBe(409);
    expect(
      (
        await call(route, {
          mutationId: randomUUID(),
          expectedVersionId: removeReceipt.versionId,
          operation: 'restore',
        })
      ).status
    ).toBe(409);
    expect((await call(`/workflows/${workflow.id}/executions`)).body.executions).toHaveLength(1);
    await embedded!.stop();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await db.close();
    failCleanup = false;
    db = new PGlite(directory);
    origin = await boot();
    expect(tasks.has(taskId)).toBe(false);
    expect(tasks.has(otherTask)).toBe(true);
    const lookup = await call(`/workflows/${workflow.id}/lifecycle-mutations/${mutationId}`);
    expect(lookup.body.receipt).toEqual(removeReceipt);
    expect(lookup.body.state.cleanup).toBe('complete');
    expect((await call(route, { ...body, operation: 'restore' })).status).toBe(409);
    const restored = await call(route, {
      mutationId: randomUUID(),
      expectedVersionId: removeReceipt.versionId,
      operation: 'restore',
    });
    expect(restored.status).toBe(200);
    const current = (await call(`/workflows/${workflow.id}`)).body;
    expect(current.removed).toBe(false);
    expect(current.active).toBe(false);
    expect(current.source).toBe(workflow.source);
    expect((await call('/executions/' + runId)).status).toBe(200);
    const readsBeforeReplay = taskReads;
    expect((await call(route, body)).body.receipt).toEqual(removeReceipt);
    expect(taskReads).toBe(readsBeforeReplay);
    expect((await call(`/workflows/${workflow.id}`)).body.removed).toBe(false);
    expect((await call(`/workflows/${workflow.id}/executions`)).body.executions).toHaveLength(1);
  } finally {
    await embedded?.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
