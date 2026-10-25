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

test('HTTP durable manual submissions: concurrency, conflict, owners, lost response and reopened SQL', async () => {
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
            if (req.headers['x-fixture-drop'] === '1' && status === 202) {
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
      name: 'Submission arithmetic fixture',
      language: 'typescript',
      active: false,
      metadata: { elizaOwnerEntityId: 'owner' },
      source: `import {createSmithers} from 'smthrs/create'; const api=createSmithers({}, {dbPath:process.env.ELIZA_SMTHRS_DB_PATH}); export default api.smithers(()=>api.Workflow({name:'Submission arithmetic fixture'}));`,
    };
    const workflow = await embedded!.createWorkflow(definition as any);
    const path = `/workflows/${workflow.id}`,
      submissionId = randomUUID(),
      body = { submissionId, expectedVersionId: workflow.versionId, input: { a: 7, b: 8 } };
    const results = await Promise.all(Array.from({ length: 12 }, () => call(path + '/run', body)));
    expect(results.map((x) => x.status)).toEqual(Array(12).fill(202));
    const id = results[0].body.execution.id;
    expect(new Set(results.map((x) => x.body.execution.id)).size).toBe(1);
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.embedded_executions')).rows[0]
    ).toEqual({ n: 1 });
    expect((await call(path + '/run', { ...body, input: { a: 9 } })).status).toBe(409);
    expect(
      (
        await call(path + '/run', {
          ...body,
          submissionId: randomUUID(),
          expectedVersionId: 'stale',
        })
      ).status
    ).toBe(409);
    const staleId = randomUUID();
    const refused = await call(path + '/run', {
      ...body,
      submissionId: staleId,
      expectedVersionId: 'stale',
    });
    expect(refused.body).toEqual({
      error: 'Workflow changed; review again',
      code: 'WORKFLOW_VERSION_NOT_ADMITTED',
      workflowId: workflow.id,
      submissionId: staleId,
      expectedVersionId: 'stale',
    });
    expect((await call(path + '/run', { ...body, input: { a: 9 } })).body.code).toBeUndefined();
    expect((await call(path + '/run', body, 'other')).status).toBe(404);
    expect((await call(path + '/submissions/' + submissionId, undefined, 'other')).status).toBe(
      404
    );
    expect((await call(path + '/submissions/' + randomUUID())).body.execution).toBe(null);
    // Read-only reconciliation after caller discards the accepted response.
    expect((await call(path + '/submissions/' + submissionId)).body.execution.id).toBe(id);
    // The real HTTP connection closes after committed acceptance, before any response bytes.
    const lostId = randomUUID();
    let dropped = false;
    try {
      const unexpected = await fetch(origin + path + '/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-drop': '1' },
        body: JSON.stringify({ ...body, submissionId: lostId }),
      });
      throw Error('Unexpected response ' + unexpected.status + ' ' + (await unexpected.text()));
    } catch (error) {
      if (String(error).includes('Unexpected response')) throw error;
      dropped = true;
    }
    expect(dropped).toBe(true);
    const recovered = await call(path + '/submissions/' + lostId);
    expect(recovered.body.execution.workflowVersionId).toBe(workflow.versionId);
    const revised = await embedded!.updateWorkflow(workflow.id, {
      ...definition,
      id: workflow.id,
      name: 'Revised',
    } as any);
    expect(revised.versionId).not.toBe(workflow.versionId);
    expect((await call(path + '/run', { ...body, submissionId: randomUUID() })).status).toBe(409);
    expect((await call(path + '/run', body)).body.execution.id).toBe(id);
    await embedded!.stop();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await db.close();
    db = new PGlite(directory);
    origin = await boot();
    expect((await call(path + '/submissions/' + submissionId)).body.execution.id).toBe(id);
    expect((await call(path + '/run', body)).body.execution.id).toBe(id);
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.embedded_executions')).rows[0]
    ).toEqual({ n: 2 });
  } finally {
    await embedded?.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
