import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

// The baseline must be reconstructed from the exact base + patches0001–0012,
// with its bridge fixture checkpointed after the applied Notes read. The process
// group is killed without service.stop(), simulating an actual interrupted host.
const baseline = process.env.ELIZA_WORKFLOW_UPGRADE_BASELINE;
(baseline ? test : test.skip)(
  'persisted0012 process upgrade retains pinned read receipt and finishes old run before protocol2 run',
  async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'workflow-upgrade-'));
    const checkpoint = join(artifacts, 'checkpoint.json');
    let db: PGlite | undefined,
      embedded: EmbeddedWorkflowService | undefined,
      server: http.Server | undefined;
    let state: any;
    const owned: string[] = [];
    const child = spawn(
      process.execPath,
      [
        '--conditions=eliza-source',
        'test',
        'plugins/plugin-workflow/__tests__/integration/device-bridge-e2e.test.ts',
      ],
      {
        cwd: baseline,
        detached: true,
        env: { ...process.env, ALPHA_UPGRADE_CHECKPOINT: checkpoint },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let childLog = '';
    child.stdout.on('data', (data) => {
      childLog += String(data);
    });
    child.stderr.on('data', (data) => {
      childLog += String(data);
    });
    const killed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      for (let i = 0; i < 360; i++) {
        try {
          state = JSON.parse(await readFile(checkpoint, 'utf8'));
          break;
        } catch {}
        if (child.exitCode !== null)
          throw new Error(`Baseline exited before checkpoint: ${childLog}`);
        await Bun.sleep(250);
      }
      expect(state).toBeDefined();
      process.kill(-child.pid!, 'SIGKILL');
      await killed;
      db = new PGlite(state.directory);
      owned.push(state.saved.workflowId);
      let facade: WorkflowService | undefined, bridge: WorkflowDeviceBridgeService | undefined;
      const runtime: any = {
        agentId: state.agentId,
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
      bridge = new WorkflowDeviceBridgeService(runtime);
      embedded = await EmbeddedWorkflowService.start(runtime);
      facade = new WorkflowService(runtime);
      const devices = new DeviceActionService(runtime);
      server = http.createServer((req, res) => {
        void handleWorkflowRoutes({
          req,
          res,
          method: req.method!,
          pathname: new URL(req.url!, 'http://fixture').pathname,
          runtime,
          principalId: state.owner,
          json: (_res, body, status = 200) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
          },
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as any).port}/api/workflow`;
      const call = async (path: string, body?: unknown) => {
        const response = await fetch(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: (await response.json()) as any };
      };
      const replay = await devices.receipt(
        state.credential,
        state.last.proposal.id,
        state.last.digest,
        state.last.attemptId,
        state.last.receipt
      );
      expect(replay.id).toBe(state.last.proposal.id);
      expect(replay.state).toBe('done');
      expect(replay.execution?.providerReceipt).toEqual(state.last.receipt);
      expect((await call(`/executions/${state.runId}/phone-review`)).body.versionId).toBe(
        state.saved.versionId
      );
      const completeStep = async (runId: string, stepId: string, result?: unknown) => {
        let proposal: any;
        for (let i = 0; i < 360; i++) {
          proposal = (await devices.list(state.credential)).find(
            (p) => p.payload.workflow?.runId === runId && p.payload.workflow?.stepId === stepId
          );
          if (proposal) break;
          const run = await embedded!.getExecution(runId);
          if (run.finished)
            throw new Error(`Run ended before ${stepId}: ${JSON.stringify(run.error)}`);
          await Bun.sleep(250);
        }
        expect(proposal.state).toBe('pending');
        const digest = deviceProposalDigest(proposal);
        await devices.decide(state.credential, proposal.id, digest, true);
        const claim = await devices.claim(state.credential, proposal.id, digest);
        await devices.receipt(state.credential, proposal.id, digest, claim.execution!.attemptId!, {
          outcome: 'applied',
          operationId: randomUUID(),
          ...(result ? { result } : {}),
        });
        return proposal;
      };
      await completeStep(state.runId, 'calendar', { kind: 'calendar', events: [] });
      const write = await completeStep(state.runId, 'save');
      expect(JSON.parse(write.payload.operation.body)).toEqual(state.last.receipt.result);
      const waitFinished = async (runId: string) => {
        let run: any;
        for (let i = 0; i < 360; i++) {
          run = await embedded!.getExecution(runId);
          if (run.finished) break;
          await Bun.sleep(250);
        }
        expect(run.status).toBe('finished');
      };
      await waitFinished(state.runId);
      expect(
        (await devices.list(state.credential)).filter(
          (p) => p.payload.workflow?.runId === state.runId
        )
      ).toHaveLength(3);
      const catalog = (await call('/phone/catalog')).body;
      await devices.register(state.credential, 'Upgraded synthetic phone', 2);
      const spec = {
        ...state.spec,
        name: 'New protocol2 after upgrade',
        steps: [
          { id: 'text', kind: 'Read', operation: 'supplied_text', text: 'Upgrade completed' },
          {
            id: 'notify',
            kind: 'Notify',
            operation: 'app_notification',
            source: 'text',
            title: 'Upgraded',
          },
          { id: 'speak', kind: 'Speak', operation: 'read_aloud', source: 'text' },
        ],
      };
      const created = await call('/phone/workflows', {
        spec,
        catalogRevision: catalog.catalogRevision,
        compilerRevision: catalog.compilerRevision,
        mutationId: randomUUID(),
      });
      expect(created.status).toBe(200);
      owned.push(created.body.receipt.workflowId);
      const run = await call(`/workflows/${created.body.receipt.workflowId}/run`, {
        submissionId: randomUUID(),
        expectedVersionId: created.body.receipt.versionId,
        input: {},
      });
      expect(run.status).toBe(202);
      expect((await completeStep(run.body.execution.id, 'notify')).payload.operation.type).toBe(
        'post_notification'
      );
      expect((await completeStep(run.body.execution.id, 'speak')).payload.operation.type).toBe(
        'speak_text'
      );
      await waitFinished(run.body.execution.id);
      const approvedCount = (await devices.list(state.credential)).length;
      for (const tamper of ['source', 'revision']) {
        const draft = await call('/phone/workflows', {
          spec,
          catalogRevision: catalog.catalogRevision,
          compilerRevision: catalog.compilerRevision,
          mutationId: randomUUID(),
        });
        const id = draft.body.receipt.workflowId;
        owned.push(id);
        const stored: any = (
          await db.query('SELECT workflow FROM workflow.embedded_workflows WHERE id=$1', [id])
        ).rows[0];
        if (tamper === 'source') stored.workflow.source += '\n// unreviewed executable source';
        else stored.workflow.metadata.elizaPhoneCompilerRevision = 'unknown-compiler';
        await db.query('UPDATE workflow.embedded_workflows SET workflow=$1::jsonb WHERE id=$2', [
          JSON.stringify(stored.workflow),
          id,
        ]);
        const rejected = await call(`/workflows/${id}/run`, {
          submissionId: randomUUID(),
          expectedVersionId: draft.body.receipt.versionId,
          input: {},
        });
        expect(rejected.status).toBe(202);
        let failed: any;
        for (let i = 0; i < 80; i++) {
          failed = await embedded!.getExecution(rejected.body.execution.id);
          if (failed.finished) break;
          await Bun.sleep(50);
        }
        expect(failed.status).toBe('failed');
        expect(failed.error.message).toContain('integrity mismatch');
      }
      expect((await devices.list(state.credential)).length).toBe(approvedCount);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid!, 'SIGKILL');
        await killed;
      }
      await embedded?.stop();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await db?.close();
      if (state) {
        await rm(state.directory, { recursive: true, force: true });
        for (const id of owned)
          await rm(resolveSmithersWorkflowDir(state.agentId, id), { recursive: true, force: true });
      }
      await rm(artifacts, { recursive: true, force: true });
    }
  },
  240000
);
