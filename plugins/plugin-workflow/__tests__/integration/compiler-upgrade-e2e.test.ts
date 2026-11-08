import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve } from 'node:path';
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

// Each fixture is a run persisted by an earlier build and interrupted while it
// waits after an applied Notes read (scripts/capture-upgrade-checkpoint.ts).
// The current runtime must resume and finish it, then run a new protocol2
// workflow. With only a fixture captured by the current persisted protocol this
// proves a same-version resume, not an upgrade; it becomes the upgrade test
// once the protocol changes and a new fixture is captured beside the old one.
const fixtures = join(import.meta.dir, '../fixtures/upgrade-checkpoint');
const repoRoot = resolve(import.meta.dir, '../../../..');

/** Restores the Smithers run store at this checkout's paths. */
async function restoreRuns(fixture: string, state: any): Promise<string> {
  const directory = resolveSmithersWorkflowDir(state.agentId, state.saved.workflowId);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'runs.sqlite');
  await writeFile(file, Bun.gunzipSync(await readFile(join(fixture, 'runs.sqlite.gz'))));
  const runs = new Database(file);
  const tables = runs
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'"
    )
    .all() as { name: string }[];
  for (const { name } of tables)
    for (const { name: column, type } of runs.query(`PRAGMA table_info("${name}")`).all() as {
      name: string;
      type: string;
    }[])
      if (/text/i.test(type))
        for (const [from, to] of [
          [state.smithersDirectory, directory],
          [state.repoRoot, repoRoot],
        ])
          runs.run(`UPDATE "${name}" SET "${column}"=replace("${column}",?,?)`, [from, to]);
  runs.close();
  return directory;
}

for (const name of readdirSync(fixtures).sort())
  test(`persisted run from ${name} keeps its applied read receipt and finishes before a protocol2 run`, async () => {
    const fixture = join(fixtures, name);
    const state = JSON.parse(await readFile(join(fixture, 'state.json'), 'utf8'));
    let db: PGlite | undefined,
      embedded: EmbeddedWorkflowService | undefined,
      server: http.Server | undefined;
    const owned: string[] = [state.saved.workflowId];
    try {
      db = await PGlite.create({
        loadDataDir: new Blob([await readFile(join(fixture, 'pglite-datadir.gz'))]),
      });
      await restoreRuns(fixture, state);
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
      await embedded?.stop();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await db?.close();
      for (const id of owned)
        await rm(resolveSmithersWorkflowDir(state.agentId, id), { recursive: true, force: true });
    }
  }, 240000);
