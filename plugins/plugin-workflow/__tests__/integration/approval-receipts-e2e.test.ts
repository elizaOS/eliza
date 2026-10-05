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

const presentation = { operation: 'Compute', target: 'Synthetic result', account: 'Fixture owner' };
const cases = [
  { name: 'restricted reviewer', metadata: { alphaPhone: presentation }, supported: false },
  { name: 'legacy', metadata: { alphaPhone: presentation }, supported: true },
  {
    name: 'generic',
    metadata: { approvalPresentation: { version: 1, ...presentation } },
    supported: true,
  },
  {
    name: 'generic precedence',
    metadata: {
      approvalPresentation: { version: 1, ...presentation },
      alphaPhone: { ...presentation, operation: 'Legacy operation' },
    },
    supported: true,
  },
  {
    name: 'future version refuses legacy downgrade',
    metadata: { approvalPresentation: { version: 2, ...presentation }, alphaPhone: presentation },
    supported: false,
  },
  {
    name: 'malformed presentation refuses legacy downgrade',
    metadata: { approvalPresentation: null, alphaPhone: presentation },
    supported: false,
  },
];
for (const scenario of cases)
  test(`HTTP canonical approvals (${scenario.name}): owner isolation, reviewed identity, dropped response and reopened stores`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-submission-'));
    let db = new PGlite(directory);
    let server: http.Server | undefined;
    let embedded: EmbeddedWorkflowService | undefined;
    let workflowDirectory: string | undefined;
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
      const capability = await call('/status');
      expect(capability.status).toBe(200);
      expect(capability.body.approvalReceiptProtocol).toBe(1);
      expect(capability.body.approvalPresentationProtocol).toBe(1);
      const definition = {
        name: 'Approval HTTP fixture',
        language: 'tsx',
        active: false,
        metadata: { elizaOwnerEntityId: 'owner' },
        source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {approvalDecisionSchema} from 'smthrs';import {z} from 'zod';
const {Workflow,Sequence,Approval,Task,smithers,outputs}=createSmithers({decision:approvalDecisionSchema,output:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="approval-http"><Sequence><Approval id="review"${scenario.name === 'restricted reviewer' ? ' allowedUsers={["reviewer"]}' : ''} mode="approve" output={outputs.decision} request={{title:'Calculate?',summary:'Produce synthetic arithmetic after review.',metadata:${JSON.stringify(scenario.metadata)}}}/><Task id="arithmetic" output={outputs.output}>{{value:56}}</Task></Sequence></Workflow>);`,
      };
      let authored = definition as any;
      if (scenario.name === 'generic') {
        let receivedPrompt = '';
        runtime.useModel = async (_model: unknown, options: { prompt: string }) => {
          receivedPrompt = options.prompt;
          return JSON.stringify(definition);
        };
        authored = await new WorkflowService(runtime).generateWorkflowDraft(
          'Create a simple approval to compute the selected synthetic result for Fixture owner.',
          { userId: 'owner' }
        );
        expect(receivedPrompt).toContain(
          'request.metadata.approvalPresentation = { version: 1, operation, target, account }'
        );
        expect(receivedPrompt).toContain('Never invent an account identity');
        expect(receivedPrompt).toContain('mode="approve"');
        expect(receivedPrompt).toContain('without an agent');
        expect(receivedPrompt).toContain('AgentGenerateOptions');
        expect(receivedPrompt).toContain('configured elizaOS runtime/model provider');
        expect(receivedPrompt).not.toContain('all inference is routed through elizaOS Cloud');
        expect(receivedPrompt).toContain('never drop restrictions or auto-approve');
        expect(authored.source).toBe(definition.source);
      }
      const workflow = await embedded!.createWorkflow(authored);
      workflowDirectory = resolveSmithersWorkflowDir(runtime.agentId, workflow.id);
      const started = await call(`/workflows/${workflow.id}/run`, {
        submissionId: randomUUID(),
        expectedVersionId: workflow.versionId,
        input: {},
      });
      expect(started.status).toBe(202);
      const id = started.body.execution.id,
        route = `/executions/${id}/approvals`;
      let pending: any;
      for (let i = 0; i < 100; i++) {
        const r = await call(route);
        if (r.status === 200 && r.body.approvals.length) {
          pending = r.body;
          break;
        }
        await Bun.sleep(100);
      }
      expect(pending.approvals).toHaveLength(1);
      const approval = pending.approvals[0];
      expect(approval.status).toBe('pending');
      expect(approval.supported).toBe(scenario.supported);
      if (scenario.supported) expect(approval.operation).toBe('Compute');
      expect((await call(route, undefined, 'other')).status).toBe(404);
      const decisionRoute = route + '/review/' + approval.iteration,
        decision = {
          approved: true,
          requestDigest: approval.requestDigest,
          expectedVersionId: workflow.versionId,
        };
      expect((await call(decisionRoute, decision, 'other')).status).toBe(404);
      if (!scenario.supported) {
        expect((await call(decisionRoute, { approved: true })).status).toBe(422);
        expect((await call(route)).body.approvals[0].status).toBe('pending');
        expect((await call(decisionRoute, decision)).status).toBe(422);
        expect((await call(route)).body.approvals[0].status).toBe('pending');
        expect((await call(decisionRoute, { ...decision, approved: false })).status).toBe(202);
        expect((await call(route)).body.approvals[0].status).toBe('denied');
        return;
      }
      expect((await call(decisionRoute, { ...decision, expectedVersionId: 'stale' })).status).toBe(
        409
      );
      expect(
        (await call(decisionRoute, { ...decision, requestDigest: '0'.repeat(64) })).status
      ).toBe(409);
      expect((await call(route)).body.approvals[0].status).toBe('pending');
      let dropped = false;
      try {
        const response = await fetch(origin + decisionRoute, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fixture-drop': '1' },
          body: JSON.stringify(decision),
        });
        const body = await response.json();
        dropped = body === null;
      } catch {
        dropped = true;
      }
      expect(dropped).toBe(true);
      const readback = await call(route);
      expect(readback.body.approvals[0].status).toBe('approved');
      expect(readback.body.approvals[0].requestDigest).toBe(approval.requestDigest);
      expect(readback.body.approvals[0].decidedBy).toBe('owner');
      expect((await call(decisionRoute, decision)).status).toBe(202);
      expect((await call(decisionRoute, { ...decision, approved: false })).status).toBe(409);
      await embedded!.stop();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
      await db.close();
      db = new PGlite(directory);
      origin = await boot();
      expect((await call(route)).body.approvals[0].status).toBe('approved');
    } finally {
      await embedded?.stop();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await db.close();
      await rm(directory, { recursive: true, force: true });
      if (workflowDirectory) await rm(workflowDirectory, { recursive: true, force: true });
    }
  }, 120000);
