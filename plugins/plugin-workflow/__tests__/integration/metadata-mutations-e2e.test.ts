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

test('HTTP metadata-only CAS: concurrency, owner binding, no executable changes, lost response and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-submission-'));
  let db = new PGlite(directory);
  let server: http.Server | undefined;
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

 CREATE TABLE workflow.metadata_mutations(agent_id text NOT NULL,workflow_id text NOT NULL,mutation_id text NOT NULL,owner_id text NOT NULL,expected_version_id text NOT NULL,name text NOT NULL,description text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,workflow_id,mutation_id));
 CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`);
    let runtime: any;
    const boot = async () => {
      runtime = {
        agentId: '00000000-0000-4000-8000-000000000001',
        db: drizzle(db, { schema }),
        getTasks: async () => [],
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
      name: 'Metadata fixture',
      description: 'Original description',
      language: 'typescript',
      active: false,
      metadata: { elizaOwnerEntityId: 'owner' },
      source: `import {createSmithers} from 'smthrs/create';const api=createSmithers({}, {dbPath:process.env.ELIZA_SMTHRS_DB_PATH});export default api.smithers(()=>api.Workflow({name:'Unchanged source'}));`,
    };
    const workflow = await embedded!.createWorkflow(definition as any),
      route = `/workflows/${workflow.id}/metadata`,
      mutationId = randomUUID(),
      body = {
        mutationId,
        expectedVersionId: workflow.versionId,
        name: 'Edited fixture',
        description: 'Edited description',
      };
    expect((await call(route, { ...body, source: 'arbitrary' })).status).toBe(400);
    expect((await call(route, body, 'other')).status).toBe(404);
    const replies = await Promise.all(Array.from({ length: 8 }, () => call(route, body)));
    expect(replies.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(replies.map((r) => r.body.receipt.versionId)).size).toBe(1);
    const receipt = replies[0].body.receipt;
    expect(receipt.previousVersionId).toBe(workflow.versionId);
    expect(receipt.name).toBe('Edited fixture');
    const current = (await call(`/workflows/${workflow.id}`)).body;
    const omit = (value: any) =>
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => !['name', 'description', 'updatedAt', 'versionId'].includes(key)
        )
      );
    expect(omit(await embedded!.getWorkflow(workflow.id))).toEqual(omit(workflow));
    expect(current.source).toBe(workflow.source);
    expect(current.active).toBe(workflow.active);
    expect((await call(`/workflows/${workflow.id}/executions`)).body.executions).toHaveLength(0);
    expect((await call(route, { ...body, description: 'conflicting' })).status).toBe(409);
    expect((await call(route, { ...body, description: 'conflicting' })).body.code).toBeUndefined();
    const staleId = randomUUID(),
      stale = await call(route, { ...body, mutationId: staleId });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: 'Workflow changed; review again',
      code: 'WORKFLOW_METADATA_NOT_APPLIED',
      workflowId: workflow.id,
      mutationId: staleId,
      expectedVersionId: workflow.versionId,
    });
    expect(
      (await call(`/workflows/${workflow.id}/metadata-mutations/${staleId}`)).body.receipt
    ).toBeNull();
    const lookup = `/workflows/${workflow.id}/metadata-mutations/${mutationId}`;
    expect((await call(lookup, undefined, 'other')).status).toBe(404);
    expect((await call(lookup)).body.receipt).toEqual(receipt);
    const lostId = randomUUID(),
      lostBody = {
        ...body,
        mutationId: lostId,
        expectedVersionId: receipt.versionId,
        name: 'After lost response',
      };
    let lost = false;
    try {
      const response = await fetch(origin + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-drop': '1' },
        body: JSON.stringify(lostBody),
      });
      lost = (await response.json()) === null;
    } catch {
      lost = true;
    }
    expect(lost).toBe(true);
    const recovered = (await call(`/workflows/${workflow.id}/metadata-mutations/${lostId}`)).body
      .receipt;
    expect(recovered.name).toBe(lostBody.name);
    expect(recovered.previousVersionId).toBe(receipt.versionId);
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.metadata_mutations')).rows[0]
    ).toEqual({ n: 2 });
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.workflow_revisions')).rows[0]
    ).toEqual({ n: 2 });
    await embedded!.stop();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await db.close();
    db = new PGlite(directory);
    origin = await boot();
    expect(
      (await call(`/workflows/${workflow.id}/metadata-mutations/${lostId}`)).body.receipt
    ).toEqual(recovered);
    expect((await call(route, lostBody)).body.receipt).toEqual(recovered);
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.workflow_revisions')).rows[0]
    ).toEqual({ n: 2 });
  } finally {
    await embedded?.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
