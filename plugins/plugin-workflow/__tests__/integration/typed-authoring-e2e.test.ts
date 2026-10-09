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
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';
import { WorkflowService } from '../../src/services/workflow-service';

test('HTTP typed creation and full edit: bounded data, owner CAS, concurrency, lost response and SQL restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-submission-'));
  let db = new PGlite(directory);
  let server: http.Server | undefined;
  let embedded: EmbeddedWorkflowService | undefined;
  const ownedWorkflowIds: string[] = [];
  try {
    await db.exec(`
    CREATE SCHEMA workflow;
    CREATE TABLE workflow.typed_mutations(agent_id text NOT NULL,owner_id text NOT NULL,mutation_id text NOT NULL,request_digest text NOT NULL,workflow_id text NOT NULL,receipt jsonb NOT NULL,PRIMARY KEY(agent_id,owner_id,mutation_id));
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
        getModel: () => undefined,
        getTasks: async () => [],
        emitEvent: async () => {},
        getService: (name: string) =>
          name === 'embedded_workflow_service'
            ? embedded
            : name === 'workflow'
              ? facade
              : undefined,
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
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
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

    const catalog = (await call('/phone/catalog')).body;
    expect(catalog.palette.map((p: any) => p.kind)).toEqual([
      'Read',
      'If',
      'Write',
      'Send',
      'Notify',
      'Speak',
      'Do',
    ]);
    expect(catalog.palette[2].operations.find((p: any) => p.id === 'model_draft').available).toBe(
      false
    );
    const spec = {
      version: 1,
      name: 'My reviewed draft',
      description: 'Explicit supplied text',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 'read',
          kind: 'Read',
          operation: 'supplied_text',
          text: 'A meaningful personal draft',
        },
        {
          id: 'condition',
          kind: 'If',
          operation: 'contains',
          source: 'read',
          text: 'draft',
          caseSensitive: false,
        },
        {
          id: 'write',
          kind: 'Write',
          operation: 'compose_draft',
          source: 'read',
          prefix: 'Reviewed: ',
          suffix: '.',
        },
      ],
    };
    const review = {
      spec,
      catalogRevision: catalog.catalogRevision,
      compilerRevision: catalog.compilerRevision,
    };
    const validation = await call('/phone/validate', review);
    expect(validation.status).toBe(200);
    expect(validation.body.effects).toEqual([]);
    for (const invalid of [
      { ...review, source: 'console.log(1)' },
      { ...review, spec: { ...spec, source: 'throw Error()' } },
      { ...review, spec: { ...spec, trigger: { kind: 'time' } } },
      { ...review, spec: { ...spec, steps: [{ id: 'bad', kind: 'Send', operation: 'send' }] } },
      {
        ...review,
        spec: {
          ...spec,
          steps: [
            ...spec.steps,
            {
              id: 'model',
              kind: 'Write',
              operation: 'model_draft',
              source: 'read',
              instruction: 'draft',
            },
          ],
        },
      },
    ])
      expect((await call('/phone/validate', invalid)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.embedded_workflows')).rows[0]
    ).toEqual({ n: 0 });
    const mutationId = randomUUID(),
      body = { ...review, mutationId };
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => call('/phone/workflows', body))
    );
    expect(replies.map((r) => r.status)).toEqual(Array(6).fill(200));
    const receipt = replies[0].body.receipt,
      id = receipt.workflowId;
    ownedWorkflowIds.push(id);
    expect(new Set(replies.map((r) => r.body.receipt.workflowId)).size).toBe(1);
    expect(
      (await call('/phone/workflows', { ...body, spec: { ...spec, name: 'Other' } })).status
    ).toBe(409);
    expect(
      (await call(`/phone/mutations/${mutationId}`, undefined, 'other')).body.receipt
    ).toBeNull();
    const saved = await embedded?.getWorkflow(id);
    expect(saved.active).toBe(false);
    expect(JSON.parse(String(saved.metadata?.elizaPhoneWorkflowSpec))).toEqual(spec);
    expect((await call(`/workflows/${id}/activate`, {})).status).toBe(409);
    expect(
      (
        await call(`/workflows/${id}/metadata`, {
          mutationId: randomUUID(),
          expectedVersionId: receipt.versionId,
          name: 'Illegal partial edit',
          description: '',
        })
      ).status
    ).toBe(409);
    expect((await call('/workflows', { workflow: saved })).status).toBe(409);
    const edit = {
      ...review,
      mutationId: randomUUID(),
      expectedVersionId: receipt.versionId,
      spec: { ...spec, name: 'My changed draft' },
    };
    expect((await call(`/workflows/${id}/phone-spec`, edit, 'other')).status).toBe(404);
    const editReplies = await Promise.all(
      Array.from({ length: 6 }, () => call(`/workflows/${id}/phone-spec`, edit))
    );
    expect(editReplies.map((reply) => reply.status)).toEqual(Array(6).fill(200));
    expect(new Set(editReplies.map((reply) => reply.body.receipt.versionId)).size).toBe(1);
    const edited = editReplies[0];
    expect(edited.status).toBe(200);
    expect((await call(`/workflows/${id}/phone-spec`, edit)).body.receipt).toEqual(
      edited.body.receipt
    );
    const stale = await call(`/workflows/${id}/phone-spec`, { ...edit, mutationId: randomUUID() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('WORKFLOW_TYPED_NOT_APPLIED');
    const lostId = randomUUID(),
      lostBody = { ...review, mutationId: lostId, spec: { ...spec, name: 'Lost response draft' } };
    let lost = false;
    try {
      await (
        await fetch(`${origin}/phone/workflows`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fixture-drop': '1' },
          body: JSON.stringify(lostBody),
        })
      ).json();
    } catch {
      lost = true;
    }
    expect(lost).toBe(true);
    const recovered = (await call(`/phone/mutations/${lostId}`)).body.receipt;
    expect(recovered.operation).toBe('create');
    ownedWorkflowIds.push(recovered.workflowId);
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.embedded_workflows')).rows[0]
    ).toEqual({ n: 2 });
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.embedded_executions')).rows[0]
    ).toEqual({ n: 0 });
    await embedded?.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await db.close();
    db = new PGlite(directory);
    origin = await boot();
    expect((await call(`/phone/mutations/${lostId}`)).body.receipt).toEqual(recovered);
    expect((await call('/phone/workflows', lostBody)).body.receipt).toEqual(recovered);
    expect(
      (await db.query('SELECT count(*)::int n FROM workflow.workflow_revisions')).rows[0]
    ).toEqual({ n: 1 });
    const admission = await call(`/workflows/${id}/run`, {
      submissionId: randomUUID(),
      expectedVersionId: edited.body.receipt.versionId,
      input: {},
    });
    expect(admission.status).toBe(202);
    const runId = admission.body.execution.id;
    let execution: any;
    for (let i = 0; i < 240; i++) {
      execution = (await call(`/executions/${runId}`)).body.execution;
      if (execution.finished) break;
      await Bun.sleep(250);
    }
    expect(execution.status).toBe('finished');
    expect(execution.output).toHaveLength(1);
    expect(execution.output[0].runId).toBe(runId);
    expect(execution.output[0].text).toBe('Reviewed: A meaningful personal draft.');
    expect(execution.output[0].steps.map((step: any) => step.id)).toEqual([
      'read',
      'condition',
      'write',
    ]);
  } finally {
    await embedded?.stop();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
    for (const id of ownedWorkflowIds)
      await rm(resolveSmithersWorkflowDir('00000000-0000-4000-8000-000000000001', id), {
        recursive: true,
        force: true,
      });
  }
}, 180000);
