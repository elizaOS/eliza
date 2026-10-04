import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { setCloudRuntimeRequestIdentity } from '@elizaos/contracts';
import { registerHttpPluginRoutes } from '@elizaos/host/protocol';
import { drizzle } from 'drizzle-orm/pglite';
import { tryHandleRuntimePluginRoute } from '../../../../packages/agent/src/api/runtime-plugin-routes';
import { DeviceActionService } from '../../../plugin-assistant/src/services/device-actions/service';
import { WorkflowDeviceBridgeService } from '../../../plugin-assistant/src/services/device-actions/workflow-service';
import * as schema from '../../src/db/schema';
import { workflowRoutePlugin } from '../../src/plugin-routes';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WorkflowService } from '../../src/services/workflow-service';

test('registered typed generation HTTP route validates real enrollment and remains unsaved until explicit save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-device-'));
  let db = new PGlite(directory);
  let embedded: any, server: http.Server | undefined;
  const agentId = '00000000-0000-4000-8000-000000000002',
    owner = 'synthetic-owner';
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
 CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));
 CREATE TABLE client_devices(agent_id uuid NOT NULL,subject_user_id text NOT NULL,installation_id text NOT NULL,enrollment_id uuid NOT NULL,key_hash text NOT NULL,label text NOT NULL,revoked boolean DEFAULT false NOT NULL,workflow_protocol integer NOT NULL DEFAULT 0,workflow_owner_id text,view_profile text,PRIMARY KEY(agent_id,subject_user_id,installation_id));
 CREATE TABLE approval_dispatch_controls(agent_id uuid NOT NULL,subject_user_id text NOT NULL,revision integer NOT NULL DEFAULT 0,paused boolean NOT NULL DEFAULT false,operation_id text,google_binding_required boolean NOT NULL DEFAULT false,retired_google_grants jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(agent_id,subject_user_id));
 CREATE TABLE approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),state text NOT NULL,requested_by text NOT NULL,subject_user_id text NOT NULL,admission_revision integer,action text NOT NULL,payload jsonb NOT NULL,channel text NOT NULL,reason text NOT NULL,idempotency_key text,expires_at timestamptz NOT NULL,resolved_at timestamptz,resolved_by text,resolution_reason text,execution_attempt_id uuid,execution_provider text,provider_idempotency_key text,execution_claimed_at timestamptz,dispatch_started_at timestamptz,provider_receipt jsonb,execution_error text,reconciliation_resolved_at timestamptz,reconciliation_resolved_by text,reconciliation_reason text,agent_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX approval_requests_agent_idempotency_uidx ON approval_requests(agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
 `);
    let facade: any, bridge: any;
    let modelAvailable = true,
      modelCalls = 0;
    const prompts: string[] = [];
    const runtime: any = {
      agentId,
      character: { name: 'Generation fixture', settings: {} },
      getSetting: () => null,
      db: drizzle(db, { schema }),
      adapter: { db: null },
      getModel: () => (modelAvailable ? {} : undefined),
      createTask: async () => {
        throw new Error('Generation must not schedule tasks');
      },
      getTasks: async () => [],
      emitEvent: async () => {},
      getService: (name: string) =>
        name === 'embedded_workflow_service'
          ? embedded
          : name === 'workflow'
            ? facade
            : name === 'workflow_device_bridge'
              ? bridge
              : undefined,
    };
    runtime.adapter.db = runtime.db;
    embedded = await EmbeddedWorkflowService.start(runtime);
    facade = new WorkflowService(runtime);
    bridge = new WorkflowDeviceBridgeService(runtime);
    const devices = new DeviceActionService(runtime),
      credential = {
        subjectUserId: owner,
        installationId: randomUUID(),
        deviceKey: 'b'.repeat(64),
      };
    const enrollment = await devices.register(credential, 'Synthetic selected phone', 2);
    const target = {
      installationId: enrollment.installationId,
      enrollmentId: enrollment.enrollmentId,
    };
    const basic = {
      version: 1,
      name: 'Generated draft',
      description: '',
      trigger: { kind: 'manual' },
      steps: [{ id: 'read', kind: 'Read', operation: 'supplied_text', text: 'Synthetic review' }],
    };
    let output = JSON.stringify(basic);
    let duringModel: (() => Promise<void>) | undefined;
    runtime.useModel = async (_type: unknown, args: { prompt: string }) => {
      modelCalls++;
      prompts.push(args.prompt);
      await duringModel?.();
      return output;
    };
    const ownerToken = randomUUID(),
      otherToken = randomUUID();
    registerHttpPluginRoutes(runtime, workflowRoutePlugin);
    server = http.createServer(async (req, res) => {
      // Fixture authentication maps opaque tokens to server-selected identities.
      const token = req.headers.authorization;
      const authorized = token === `Bearer ${ownerToken}` || token === `Bearer ${otherToken}`;
      if (authorized)
        setCloudRuntimeRequestIdentity(
          req,
          token === `Bearer ${ownerToken}` ? owner : 'other-owner'
        );
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const handled = await tryHandleRuntimePluginRoute({
        req,
        res,
        method: req.method ?? 'GET',
        pathname: url.pathname,
        url,
        runtime,
        isAuthorized: () => authorized,
      });
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/workflow`;
    const call = async (path: string, body?: unknown, token = ownerToken) => {
      const res = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const catalog = (await call('/phone/catalog')).body;
    expect(catalog.generationProtocol).toBe(1);
    const revisions = {
      catalogRevision: catalog.catalogRevision,
      compilerRevision: catalog.compilerRevision,
    };
    const request = {
      prompt: 'Make a reviewed draft',
      operations: [
        'supplied_text',
        'selected_notes',
        'calendar_range',
        'compose_draft',
        'save_note',
        'read_aloud',
      ],
      device: target,
      ...revisions,
    };
    const generate = (body: unknown = request, token = ownerToken) =>
      call('/phone/generate', body, token);
    const noWrites = async () => {
      for (const table of [
        'embedded_workflows',
        'embedded_executions',
        'typed_mutations',
        'workflow_revisions',
        'manual_submissions',
      ]) {
        expect(
          (
            await db.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM workflow.${table}`
            )
          ).rows[0].count
        ).toBe(0);
      }
      expect(
        (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM approval_requests'))
          .rows[0].count
      ).toBe(0);
    };
    const first = await generate();
    expect(first.status).toBe(200);
    expect(first.body.spec).toEqual({ ...basic, device: target });
    expect(first.body.active).toBe(false);
    expect(first.body.specDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(modelCalls).toBe(1);
    expect(prompts[0]).not.toContain(target.enrollmentId);
    expect(prompts[0]).not.toContain(target.installationId);
    await noWrites();
    for (const [body, token] of [
      [request, 'invalid'],
      [request, otherToken],
      [{ ...request, catalogRevision: 'stale' }, ownerToken],
      [{ ...request, operations: ['send_email'] }, ownerToken],
      [{ ...request, activate: true }, ownerToken],
      [{ ...request, prompt: 'x'.repeat(4001) }, ownerToken],
    ] as const) {
      const before = modelCalls;
      expect((await generate(body, token)).status).toBeGreaterThanOrEqual(400);
      expect(modelCalls).toBe(before);
    }
    // Valid JSON with insignificant whitespace must hit the wire cap before
    // dispatcher pre-parsing shrinks it into a small attached request.body.
    const padded = JSON.stringify(request) + ' '.repeat(75001);
    expect(JSON.parse(padded)).toEqual(request);
    const callsBeforeOversize = modelCalls;
    const oversized = await fetch(origin + '/phone/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: padded,
    }).then(
      (res) => res.status,
      () => 'connection closed'
    );
    expect(oversized === 'connection closed' || oversized >= 400).toBe(true);
    expect(modelCalls).toBe(callsBeforeOversize);
    modelAvailable = false;
    expect((await generate()).status).toBe(409);
    modelAvailable = true;
    const revoked = async (value: boolean) => {
      await db.query('UPDATE client_devices SET revoked=$1 WHERE enrollment_id=$2', [
        value,
        target.enrollmentId,
      ]);
    };
    await revoked(true);
    const before = modelCalls;
    expect((await generate()).status).toBe(409);
    expect(modelCalls).toBe(before);
    await revoked(false);
    duringModel = () => revoked(true);
    expect((await generate()).status).toBe(409);
    duringModel = undefined;
    await revoked(false);
    const notes = {
      id: 'notes',
      kind: 'Read',
      operation: 'selected_notes',
      notes: [{ id: 'selected-note', revision: 'a'.repeat(64) }],
    };
    const selected = { ...basic, device: target, steps: [notes] };
    output = JSON.stringify({ ...basic, steps: [notes] });
    expect((await generate({ ...request, existing: selected })).status).toBe(200);
    expect((await generate()).status).toBe(502);
    output = JSON.stringify({
      ...basic,
      steps: [{ ...notes, notes: [{ id: 'different-note', revision: 'a'.repeat(64) }] }],
    });
    expect((await generate({ ...request, existing: selected })).status).toBe(502);
    const calendar = {
      id: 'calendar',
      kind: 'Read',
      operation: 'calendar_range',
      range: {
        calendarIds: ['selected-calendar'],
        start: '2026-10-03T00:00:00.000Z',
        end: '2026-10-04T00:00:00.000Z',
        timeZone: 'UTC',
        maximumEvents: 10,
      },
    };
    output = JSON.stringify({ ...basic, steps: [calendar] });
    expect(
      (await generate({ ...request, existing: { ...basic, device: target, steps: [calendar] } }))
        .status
    ).toBe(200);
    output = JSON.stringify({
      ...basic,
      steps: [{ ...calendar, range: { ...calendar.range, maximumEvents: 20 } }],
    });
    expect(
      (await generate({ ...request, existing: { ...basic, device: target, steps: [calendar] } }))
        .status
    ).toBe(502);
    for (const rejected of [
      { ...basic, device: target },
      { ...basic, source: 'run code' },
      { ...basic, active: true },
      { ...basic, trigger: { kind: 'time' } },
      { ...basic, steps: [{ id: 'bad', kind: 'Send', operation: 'send_email' }] },
    ]) {
      output = JSON.stringify(rejected);
      expect((await generate()).status).toBe(502);
    }
    output = JSON.stringify({
      ...basic,
      steps: [
        ...basic.steps,
        { id: 'speak', kind: 'Speak', operation: 'read_aloud', source: 'read' },
      ],
    });
    expect((await generate({ ...request, operations: ['supplied_text'] })).status).toBe(502);
    await db.query('UPDATE client_devices SET workflow_protocol=1 WHERE enrollment_id=$1', [
      target.enrollmentId,
    ]);
    expect((await generate()).status).toBe(409);
    await db.query('UPDATE client_devices SET workflow_protocol=2 WHERE enrollment_id=$1', [
      target.enrollmentId,
    ]);
    expect((await generate()).status).toBe(200);
    output = JSON.stringify({ unsupported: 'Select a calendar first' });
    expect((await generate()).status).toBe(422);
    for (const malformed of ['not JSON', '[]', 'x'.repeat(65537)]) {
      output = malformed;
      expect((await generate()).status).toBe(502);
    }
    await noWrites();
    // Explicit save is a separate operation; generation itself never creates rows.
    const save = { ...revisions, spec: first.body.spec, mutationId: randomUUID() };
    expect((await call('/phone/workflows', save)).status).toBe(200);
    expect((await call('/phone/workflows', save)).status).toBe(200);
    await embedded.stop();
    embedded = undefined;
    await db.close();
    db = new PGlite(directory);
    const rows = (
      await db.query<{ active: boolean }>('SELECT active FROM workflow.embedded_workflows')
    ).rows;
    expect(rows).toEqual([{ active: false }]);
    expect(
      (
        await db.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM workflow.embedded_executions'
        )
      ).rows[0].count
    ).toBe(0);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await embedded?.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
