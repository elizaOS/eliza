import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  DeviceActionService,
  deviceProposalDigest,
} from '../../../plugin-assistant/src/services/device-actions/service';
import { WorkflowDeviceBridgeService } from '../../../plugin-assistant/src/services/device-actions/workflow-service';
import * as schema from '../../src/db/schema';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';
import { WorkflowService } from '../../src/services/workflow-service';

test('typed workflow HTTP and real SQL canonical device approval bridge binds Notes/Calendar reads and Notes write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-device-'));
  let db = new PGlite(directory);
  let embedded: any, server: http.Server | undefined;
  const owned: string[] = [];
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
 CREATE TABLE client_devices(agent_id uuid NOT NULL,subject_user_id text NOT NULL,installation_id text NOT NULL,enrollment_id uuid NOT NULL,key_hash text NOT NULL,label text NOT NULL,revoked boolean DEFAULT false NOT NULL,workflow_protocol integer NOT NULL DEFAULT 0, workflow_owner_id text, view_profile text,PRIMARY KEY(agent_id,subject_user_id,installation_id));
 CREATE TABLE approval_dispatch_controls(agent_id uuid NOT NULL,subject_user_id text NOT NULL,revision integer NOT NULL DEFAULT 0,paused boolean NOT NULL DEFAULT false,operation_id text,google_binding_required boolean NOT NULL DEFAULT false,retired_google_grants jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(agent_id,subject_user_id));
 CREATE TABLE approval_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),state text NOT NULL,requested_by text NOT NULL,subject_user_id text NOT NULL,admission_revision integer,action text NOT NULL,payload jsonb NOT NULL,channel text NOT NULL,reason text NOT NULL,idempotency_key text,expires_at timestamptz NOT NULL,resolved_at timestamptz,resolved_by text,resolution_reason text,execution_attempt_id uuid,execution_provider text,provider_idempotency_key text,execution_claimed_at timestamptz,dispatch_started_at timestamptz,provider_receipt jsonb,execution_error text,reconciliation_resolved_at timestamptz,reconciliation_resolved_by text,reconciliation_reason text,agent_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX approval_requests_agent_idempotency_uidx ON approval_requests(agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
 `);
    let facade: any, bridge: any;
    const runtime: any = {
      agentId,
      db: drizzle(db, { schema }),
      adapter: { db: null },
      getModel: () => undefined,
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
    const enrollment = await devices.register(credential, 'Synthetic selected phone', 1);
    const target = {
      installationId: enrollment.installationId,
      enrollmentId: enrollment.enrollmentId,
    };
    server = http.createServer((req, res) => {
      void handleWorkflowRoutes({
        req,
        res,
        method: req.method!,
        pathname: new URL(req.url!, 'http://fixture').pathname,
        runtime,
        principalId: req.headers['x-fixture-owner'] === 'other' ? 'other' : owner,
        json: (response, body, status = 200) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        },
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}/api/workflow`;
    const call = async (path: string, body?: unknown, other = false) => {
      const r = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-owner': other ? 'other' : owner },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    const note = {
        id: 'selected-note',
        title: 'Selected synthetic note',
        text: 'Remember the meeting. ' + 'é'.repeat(25000),
      },
      revision = createHash('sha256')
        .update(JSON.stringify([note.title, note.text]))
        .digest('hex');
    const catalog = (await call('/phone/catalog')).body;
    const spec = {
      version: 1,
      name: 'Reviewed native read and save',
      description: 'Actual queue, synthetic native receipts',
      trigger: { kind: 'manual' },
      device: target,
      steps: [
        {
          id: 'notes',
          kind: 'Read',
          operation: 'selected_notes',
          notes: [{ id: note.id, revision }],
        },
        {
          id: 'calendar',
          kind: 'Read',
          operation: 'calendar_range',
          range: {
            calendarIds: ['1'],
            start: '2026-09-30T00:00:00.000Z',
            end: '2026-10-01T00:00:00.000Z',
            timeZone: 'UTC',
            maximumEvents: 20,
          },
        },
        {
          id: 'save',
          kind: 'Write',
          operation: 'save_note',
          source: 'notes',
          title: 'Reviewed copy',
        },
      ],
    };
    const review = {
      spec,
      catalogRevision: catalog.catalogRevision,
      compilerRevision: catalog.compilerRevision,
    };
    expect((await call('/phone/validate', review)).status).toBe(200);
    expect((await call('/phone/validate', review, true)).status).toBe(409);
    expect(await devices.list(credential)).toHaveLength(0);
    const created = await call('/phone/workflows', { ...review, mutationId: randomUUID() });
    expect(created.status).toBe(200);
    const saved = created.body.receipt;
    owned.push(saved.workflowId);
    expect(await devices.list(credential)).toHaveLength(0);
    const run = await call(`/workflows/${saved.workflowId}/run`, {
      submissionId: randomUUID(),
      expectedVersionId: saved.versionId,
      input: {},
    });
    expect(run.status).toBe(202);
    const runId = run.body.execution.id;
    const read = await call(`/executions/${runId}/phone-review`);
    expect(read.body.spec).toEqual(spec);
    expect((await call(`/executions/${runId}/phone-review`, undefined, true)).status).toBe(404);
    let last: any;
    for (const stepId of ['notes', 'calendar', 'save']) {
      let proposal: any;
      for (let i = 0; i < 240; i++) {
        proposal = (await devices.list(credential)).find(
          (p) => p.payload.workflow?.runId === runId && p.payload.workflow?.stepId === stepId
        );
        if (proposal) break;
        await Bun.sleep(250);
      }
      expect(proposal).toBeDefined();
      expect(proposal.state).toBe('pending');
      expect((await call(`/executions/${runId}`)).body.execution.status).toBe('waiting-approval');
      expect(proposal.payload.workflow.specDigest).toBe(saved.specDigest);
      const duplicates = await Promise.all(
        Array.from({ length: 4 }, () =>
          devices.proposeForWorkflow(owner, {
            binding: proposal.payload.workflow,
            target,
            operation: proposal.payload.operation,
          })
        )
      );
      expect(new Set(duplicates.map((p) => p.id)).size).toBe(1);
      await expect(
        devices.proposeForWorkflow('other', {
          binding: proposal.payload.workflow,
          target,
          operation: proposal.payload.operation,
        })
      ).rejects.toThrow();
      const digest = deviceProposalDigest(proposal);
      await devices.decide(credential, proposal.id, digest, true);
      const claimed = await devices.claim(credential, proposal.id, digest);
      const receipt: any = {
        outcome: 'applied',
        operationId: randomUUID(),
        ...(stepId === 'notes'
          ? { result: { kind: 'notes', notes: [{ ...note, revision }] } }
          : stepId === 'calendar'
            ? { result: { kind: 'calendar', events: [] } }
            : {}),
      };
      if (stepId === 'notes') {
        await expect(
          devices.receipt(credential, proposal.id, digest, claimed.execution!.attemptId!, {
            ...receipt,
            result: { kind: 'notes', notes: [{ ...note, revision, text: 'tampered' }] },
          })
        ).rejects.toThrow();
      }
      if (stepId === 'save')
        expect(JSON.parse(proposal.payload.operation.body)).toEqual({
          kind: 'notes',
          notes: [{ id: note.id, revision, title: note.title, text: note.text }],
        });
      const settled = await devices.receipt(
        credential,
        proposal.id,
        digest,
        claimed.execution!.attemptId!,
        receipt
      );
      expect(settled.state).toBe('done');
      expect(
        (
          await devices.receipt(
            credential,
            proposal.id,
            digest,
            claimed.execution!.attemptId!,
            receipt
          )
        ).id
      ).toBe(proposal.id);
      last = { proposal, digest, attemptId: claimed.execution!.attemptId!, receipt };
    }
    let completed: any;
    for (let i = 0; i < 240; i++) {
      completed = (await call(`/executions/${runId}`)).body.execution;
      if (completed.finished) break;
      await Bun.sleep(250);
    }
    expect(completed.status).toBe('finished');
    expect(await devices.list(credential)).toHaveLength(3);
    expect(
      (await db.query("SELECT count(*)::int n FROM approval_requests WHERE state='done'")).rows[0]
    ).toEqual({ n: 3 });
    const changed = await call(`/workflows/${saved.workflowId}/phone-spec`, {
      ...review,
      spec: { ...spec, name: 'Later version' },
      mutationId: randomUUID(),
      expectedVersionId: saved.versionId,
    });
    expect(changed.status).toBe(200);
    expect((await call(`/executions/${runId}/phone-review`)).body.spec.name).toBe(spec.name);
    const cancelledRun = await call(`/workflows/${saved.workflowId}/run`, {
      submissionId: randomUUID(),
      expectedVersionId: changed.body.receipt.versionId,
      input: {},
    });
    expect(cancelledRun.status).toBe(202);
    const cancelledId = cancelledRun.body.execution.id;
    let pending: any;
    for (let i = 0; i < 240; i++) {
      pending = (await devices.list(credential)).find(
        (p) => p.payload.workflow?.runId === cancelledId
      );
      if (pending) break;
      await Bun.sleep(250);
    }
    expect(pending.state).toBe('pending');
    expect((await call(`/executions/${cancelledId}/cancel`, {})).status).toBe(202);
    await expect(
      devices.decide(credential, pending.id, deviceProposalDigest(pending), true)
    ).rejects.toThrow();
    await devices.register(credential, 'Synthetic selected phone', 0);
    expect((await call('/phone/validate', review)).status).toBe(409);
    await devices.register(credential, 'Synthetic selected phone', 1);

    const presentationSpec = {
      ...spec,
      name: 'Reviewed notification and speech',
      steps: [
        {
          id: 'text',
          kind: 'Read',
          operation: 'supplied_text',
          text: 'Your reviewed workflow has finished.',
        },
        {
          id: 'notice',
          kind: 'Notify',
          operation: 'app_notification',
          source: 'text',
          title: 'Workflow complete',
        },
        { id: 'speech', kind: 'Speak', operation: 'read_aloud', source: 'text' },
      ],
    };
    const presentationReview = { ...review, spec: presentationSpec };
    expect((await call('/phone/validate', presentationReview)).status).toBe(409);
    await devices.register(credential, 'Synthetic selected phone', 2);
    expect((await call('/phone/validate', presentationReview)).status).toBe(200);
    const presentation = await call('/phone/workflows', {
      ...presentationReview,
      mutationId: randomUUID(),
    });
    expect(presentation.status).toBe(200);
    owned.push(presentation.body.receipt.workflowId);
    const admitted = await call(`/workflows/${presentation.body.receipt.workflowId}/run`, {
      submissionId: randomUUID(),
      expectedVersionId: presentation.body.receipt.versionId,
      input: {},
    });
    expect(admitted.status).toBe(202);
    const presentationRun = admitted.body.execution.id;
    for (const stepId of ['notice', 'speech']) {
      let proposal: any;
      for (let i = 0; i < 240; i++) {
        proposal = (await devices.list(credential)).find(
          (p) =>
            p.payload.workflow?.runId === presentationRun && p.payload.workflow?.stepId === stepId
        );
        if (proposal) break;
        await Bun.sleep(250);
      }
      expect(proposal.state).toBe('pending');
      expect(proposal.payload.operation).toEqual(
        stepId === 'notice'
          ? {
              type: 'post_notification',
              title: 'Workflow complete',
              body: 'Your reviewed workflow has finished.',
            }
          : { type: 'speak_text', text: 'Your reviewed workflow has finished.' }
      );
      await expect(
        devices.propose(
          credential,
          proposal.payload.operation,
          randomUUID(),
          'Unbound presentation'
        )
      ).rejects.toThrow();
      const proposalDigest = deviceProposalDigest(proposal);
      await devices.register(credential, 'Synthetic selected phone', 1);
      await expect(devices.decide(credential, proposal.id, proposalDigest, true)).rejects.toThrow();
      await devices.register(credential, 'Synthetic selected phone', 2);
      await devices.decide(credential, proposal.id, proposalDigest, true);
      const claim = await devices.claim(credential, proposal.id, proposalDigest);
      const outcome = { outcome: 'applied', operationId: randomUUID() };
      expect(
        (
          await devices.receipt(
            credential,
            proposal.id,
            proposalDigest,
            claim.execution!.attemptId!,
            outcome
          )
        ).state
      ).toBe('done');
    }
    for (let i = 0; i < 240; i++) {
      completed = (await call(`/executions/${presentationRun}`)).body.execution;
      if (completed.finished) break;
      await Bun.sleep(250);
    }
    expect(completed.status).toBe('finished');

    await embedded.stop();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await db.close();
    db = new PGlite(directory);
    runtime.db = drizzle(db, { schema });
    runtime.adapter.db = runtime.db;
    expect(
      (
        await new DeviceActionService(runtime).receipt(
          credential,
          last.proposal.id,
          last.digest,
          last.attemptId,
          last.receipt
        )
      ).state
    ).toBe('done');
  } finally {
    await embedded?.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
    for (const id of owned)
      await rm(resolveSmithersWorkflowDir(agentId, id), { recursive: true, force: true });
  }
}, 240000);
