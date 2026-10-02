import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { IAgentRuntime } from '@elizaos/core';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import {
  publishWorkflowSource,
  resolveSmithersWorkflowDir,
  runSmithersWorkflow,
} from '../../src/services/smithers-runtime';
import { inspectWorkerLease } from '../../src/services/workflow-worker-lease';
import type { WorkflowDefinitionResponse, WorkflowExecution } from '../../src/types/index';

const stage = import.meta.dir;

async function until(check: () => boolean) {
  const deadline = Date.now() + 12000;
  while (!check()) {
    if (Date.now() > deadline) throw Error('condition deadline');
    await Bun.sleep(10);
  }
}
for (const workerDies of [false, true])
  test(`actual Smithers parent SIGKILL preserves canonical ownership; workerDies=${workerDies}`, async () => {
    const previousHome = process.env.HOME;
    const home = fs.realpathSync(fs.mkdtempSync('/tmp/workflow-survivor-'));
    fs.chmodSync(home, 0o700);
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.eliza-worker-ipc'), { mode: 0o700 });
    const tenantId = `survivor-${randomUUID()}`,
      workflowId = 'owned-effect';
    const root = resolveSmithersWorkflowDir(tenantId, workflowId);
    fs.mkdirSync(root, { recursive: true });
    const effect = path.join(root, 'effect-count'),
      ready = path.join(root, 'effect-ready'),
      release = path.join(root, 'effect-release');
    const source = `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';import * as fs from 'node:fs';
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({value:z.number(),valid:z.boolean(),detail:z.object({label:z.string()})})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
const agent={id:'owned-local-fixture',generate:async()=>{fs.appendFileSync(${JSON.stringify(effect)},'effect\\n');fs.writeFileSync(${JSON.stringify(ready)},'ready');const deadline=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('owned effect release deadline');await new Promise(r=>setTimeout(r,10));}fs.writeFileSync(${JSON.stringify(path.join(root, 'effect-finished'))},'finished');return {text:'{"value":1,"valid":true,"detail":{"label":"survived"}}'};}};
export default smithers(()=><Workflow name="survivor"><Task id="effect" output={outputs.output} agent={agent}>Perform the owned local fixture.</Task></Workflow>);`;
    const workflow = {
      id: workflowId,
      name: 'Survivor',
      active: true,
      language: 'tsx' as const,
      steps: [],
      widgets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versionId: 'v1',
      source,
    };
    const request = {
      tenantId,
      workflow,
      runId: randomUUID(),
      mode: 'manual' as const,
      input: {},
      timeoutMs: 20000,
    };
    const lease = {
      rootDir: fs.realpathSync(root),
      socketRoot: fs.realpathSync(path.join(home, '.eliza-worker-ipc')),
      runId: request.runId,
      versionId: 'v1',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
    };
    let database = new PGlite(path.join(home, 'projection'));
    await database.exec(
      `CREATE SCHEMA workflow;CREATE TABLE workflow.embedded_workflows(agent_id text NOT NULL,id text NOT NULL,name text NOT NULL,active boolean NOT NULL,workflow jsonb NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,version_id text NOT NULL,PRIMARY KEY(agent_id,id));CREATE TABLE workflow.embedded_executions(agent_id text NOT NULL,id text NOT NULL,workflow_id text NOT NULL,status text NOT NULL,mode text NOT NULL,finished boolean NOT NULL,started_at text NOT NULL,stopped_at text,execution jsonb NOT NULL,idempotency_key text,PRIMARY KEY(agent_id,id));`
    );
    await database.query(
      'INSERT INTO workflow.embedded_workflows VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        tenantId,
        workflowId,
        workflow.name,
        true,
        JSON.stringify(workflow),
        workflow.createdAt,
        workflow.updatedAt,
        workflow.versionId,
      ]
    );
    const runtime = {
      agentId: tenantId,
      db: drizzle(database, { schema }),
      emitEvent: async () => {},
    } as unknown as IAgentRuntime;
    let service = new EmbeddedWorkflowService(runtime);
    const pending: WorkflowExecution = {
      id: request.runId,
      workflowId,
      workflowVersionId: 'v1',
      workflowName: 'Survivor',
      mode: 'manual',
      status: 'running',
      finished: false,
      startedAt: new Date().toISOString(),
      input: {},
      events: [],
      approvals: [],
    };
    const reconcile = () =>
      (
        service as unknown as {
          runInBackground(
            workflow: WorkflowDefinitionResponse,
            pending: WorkflowExecution,
            controller: AbortController
          ): Promise<WorkflowExecution>;
        }
      ).runInBackground(workflow, pending, new AbortController());
    const parent = spawn(
      process.execPath,
      [
        '--conditions=eliza-source',
        ...(process.env.ELIZA_LEASE_TEST_PRELOAD
          ? ['--preload', process.env.ELIZA_LEASE_TEST_PRELOAD]
          : []),
        path.join(stage, '../fixtures/workflow-survivor-parent.ts'),
        JSON.stringify(request),
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const exited = once(parent, 'exit');
    let error = '';
    parent.stderr.on('data', (b) => (error += b));
    try {
      await until(() => fs.existsSync(ready));
      parent.kill('SIGKILL');
      await exited;
      expect((await inspectWorkerLease(lease)).state).toBe('live');
      await expect(
        runSmithersWorkflow({
          ...request,
          generate: async () => {
            throw Error('duplicate generation');
          },
        })
      ).rejects.toMatchObject({ code: 'WORKFLOW_WORKER_RUNNING' });
      const projectedLive = await reconcile();
      expect(projectedLive.finished).toBe(false);
      expect(projectedLive.reconciliation?.state).toBe('worker-running');
      await service.stop();
      await database.close();
      database = new PGlite(path.join(home, 'projection'));
      service = new EmbeddedWorkflowService({
        ...runtime,
        db: drizzle(database, { schema }),
      } as unknown as IAgentRuntime);
      expect((await service.getExecution(request.runId)).reconciliation?.state).toBe(
        'worker-running'
      );
      await reconcile();
      if (workerDies) {
        const owned = await inspectWorkerLease(lease);
        if (owned.state !== 'live') throw Error('Lost owned worker identity');
        process.kill(owned.pid, 'SIGKILL');
        await until(() => {
          try {
            process.kill(owned.pid, 0);
            return false;
          } catch {
            return true;
          }
        });
        await expect(
          runSmithersWorkflow({
            ...request,
            generate: async () => {
              throw Error('duplicate generation');
            },
          })
        ).rejects.toMatchObject({ code: 'WORKFLOW_WORKER_OUTCOME_UNKNOWN' });
        const projectedUnknown = await reconcile();
        expect(projectedUnknown.finished).toBe(false);
        expect(projectedUnknown.reconciliation?.state).toBe('outcome-unknown');
        await service.stop();
        await database.close();
        database = new PGlite(path.join(home, 'projection'));
        service = new EmbeddedWorkflowService({
          ...runtime,
          db: drizzle(database, { schema }),
        } as unknown as IAgentRuntime);
        expect((await service.getExecution(request.runId)).reconciliation?.state).toBe(
          'outcome-unknown'
        );
        expect(fs.readFileSync(effect, 'utf8')).toBe('effect\n');
        return;
      }
      fs.writeFileSync(release, 'finish');
      await until(
        () =>
          !fs.existsSync(
            path.join(
              root,
              '.worker-owners',
              createHash('sha256').update(request.runId).digest('hex')
            )
          )
      );
      const projectionDeadline = Date.now() + 10000;
      while (!(await service.getExecution(request.runId)).finished) {
        if (Date.now() > projectionDeadline) throw Error('Automatic canonical projection deadline');
        await Bun.sleep(10);
      }
      const replay = await runSmithersWorkflow({
        ...request,
        generate: async () => {
          throw Error('duplicate generation');
        },
      });
      expect(replay.status).toBe('finished');
      const expectedOutput = [
        {
          runId: request.runId,
          nodeId: 'effect',
          iteration: 0,
          value: 1,
          valid: true,
          detail: { label: 'survived' },
        },
      ];
      expect(replay.output).toEqual(expectedOutput);
      const projectedDone = await service.getExecution(request.runId);
      expect(projectedDone.finished).toBe(true);
      expect(projectedDone.output).toEqual(expectedOutput);
      expect(projectedDone.reconciliation).toBeUndefined();
      expect((await service.getExecution(request.runId)).reconciliation).toBeUndefined();
      expect(fs.readFileSync(effect, 'utf8')).toBe('effect\n');
    } catch (e) {
      throw new Error(
        `${String(e)}\n${error}\nLEASE ${JSON.stringify(await inspectWorkerLease(lease))}\nFILES ${JSON.stringify(fs.readdirSync(root))}`
      );
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGKILL');
        await exited;
      }
      fs.writeFileSync(release, 'finish');
      await service.stop();
      await database.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  }, 25000);

for (const boundary of ['execution', 'version', 'concurrent'] as const) {
  test(`database admission ${boundary} is serialized and drained by stop`, async () => {
    const database = new PGlite();
    const tenantId = randomUUID();
    const timestamp = new Date().toISOString();
    const workflow = {
      id: 'admission',
      name: 'Admission',
      active: true,
      language: 'tsx',
      source: 'export default {};',
      steps: [],
      widgets: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      versionId: 'v1',
    };
    const execution = {
      id: randomUUID(),
      workflowId: workflow.id,
      workflowVersionId: 'v1',
      workflowName: workflow.name,
      mode: 'manual',
      status: 'running',
      finished: false,
      startedAt: timestamp,
      input: {},
      events: [],
      approvals: [],
    } as WorkflowExecution;
    await database.exec(
      `CREATE SCHEMA workflow;CREATE TABLE workflow.embedded_workflows(agent_id text NOT NULL,id text NOT NULL,name text NOT NULL,active boolean NOT NULL,workflow jsonb NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,version_id text NOT NULL,PRIMARY KEY(agent_id,id));CREATE TABLE workflow.embedded_executions(agent_id text NOT NULL,id text NOT NULL,workflow_id text NOT NULL,status text NOT NULL,mode text NOT NULL,finished boolean NOT NULL,started_at text NOT NULL,stopped_at text,execution jsonb NOT NULL,idempotency_key text,PRIMARY KEY(agent_id,id));`
    );
    await database.query(
      'INSERT INTO workflow.embedded_workflows VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        tenantId,
        workflow.id,
        workflow.name,
        true,
        JSON.stringify(workflow),
        timestamp,
        timestamp,
        'v1',
      ]
    );
    await database.query(
      'INSERT INTO workflow.embedded_executions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        tenantId,
        execution.id,
        workflow.id,
        'running',
        'manual',
        false,
        timestamp,
        null,
        JSON.stringify(execution),
        null,
      ]
    );
    const service = new EmbeddedWorkflowService({
      agentId: tenantId,
      db: drizzle(database, { schema }),
      emitEvent: async () => {},
    } as unknown as IAgentRuntime);
    const internal = service as unknown as {
      resumeExecution(e: WorkflowExecution): Promise<void>;
      workflowVersionForExecution(e: WorkflowExecution): Promise<WorkflowDefinitionResponse>;
      runInBackground(
        w: WorkflowDefinitionResponse,
        e: WorkflowExecution,
        c: AbortController
      ): Promise<WorkflowExecution>;
    };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const get = service.getExecution.bind(service);
    const version = internal.workflowVersionForExecution.bind(service);
    let launches = 0,
      reads = 0;
    if (boundary === 'execution')
      service.getExecution = async (id) => {
        const row = await get(id);
        reads++;
        entered();
        await gate;
        return row;
      };
    else
      internal.workflowVersionForExecution = async (e) => {
        const row = await version(e);
        reads++;
        entered();
        await gate;
        return row;
      };
    // Count the actual admission boundary; child-process execution is covered above.
    internal.runInBackground = async (_w, e) => {
      launches++;
      return e;
    };
    try {
      const first = internal.resumeExecution(execution);
      await reached;
      const second = internal.resumeExecution(execution);
      expect(second).toBe(first);
      if (boundary === 'concurrent') {
        release();
        await Promise.all([first, second]);
        expect(launches).toBe(1);
      } else {
        let stopped = false;
        const stopping = service.stop().then(() => {
          stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        await Promise.all([first, second, stopping]);
        expect(launches).toBe(0);
        await internal.resumeExecution(execution);
        expect(launches).toBe(0);
      }
      expect(reads).toBe(1);
    } finally {
      release();
      await service.stop();
      await database.close();
    }
  });
}

test('concurrent source publication preserves an existing importer inode and rejects changed bytes', async () => {
  const root = fs.mkdtempSync('/tmp/workflow-source-');
  const target = path.join(root, 'v1.ts');
  const source = `export default ${JSON.stringify('x'.repeat(100000))};`;
  try {
    await publishWorkflowSource(target, source);
    const inode = fs.statSync(target).ino;
    const publications = Array.from({ length: 16 }, () => publishWorkflowSource(target, source));
    for (let i = 0; i < 16; i++) {
      expect(fs.readFileSync(target, 'utf8')).toBe(source);
      await Promise.resolve();
    }
    await Promise.all(publications);
    expect(fs.statSync(target).ino).toBe(inode);
    await expect(publishWorkflowSource(target, 'export default 2;')).rejects.toThrow(
      'identity mismatch'
    );
    expect(fs.readFileSync(target, 'utf8')).toBe(source);
    expect(fs.readdirSync(root)).toEqual(['v1.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const termination of ['crash', 'timeout', 'abort'] as const) {
  test(`live parent preserves unknown effects after worker ${termination}`, async () => {
    const previousHome = process.env.HOME;
    const home = fs.realpathSync(fs.mkdtempSync('/tmp/workflow-survivor-'));
    fs.chmodSync(home, 0o700);
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, '.eliza-worker-ipc'), { mode: 0o700 });
    const tenantId = `survivor-${randomUUID()}`,
      workflowId = 'owned-effect';
    const root = resolveSmithersWorkflowDir(tenantId, workflowId);
    fs.mkdirSync(root, { recursive: true });
    const effect = path.join(root, 'effect-count'),
      ready = path.join(root, 'effect-ready'),
      release = path.join(root, 'effect-release');
    const source = `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';import * as fs from 'node:fs';
const {Workflow,Task,smithers,outputs}=createSmithers({result:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
const agent={id:'owned-local-fixture',generate:async()=>{fs.appendFileSync(${JSON.stringify(effect)},'effect\\n');fs.writeFileSync(${JSON.stringify(ready)},'ready');const deadline=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)throw Error('owned effect release deadline');await new Promise(r=>setTimeout(r,10));}fs.writeFileSync(${JSON.stringify(path.join(root, 'effect-finished'))},'finished');return {text:'{"value":1}'};}};
export default smithers(()=><Workflow name="survivor"><Task id="effect" output={outputs.result} agent={agent}>Perform the owned local fixture.</Task></Workflow>);`;
    const workflow = {
      id: workflowId,
      name: 'Survivor',
      active: true,
      language: 'tsx' as const,
      steps: [],
      widgets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versionId: 'v1',
      source,
    };
    const request = {
      tenantId,
      workflow,
      runId: randomUUID(),
      mode: 'manual' as const,
      input: {},
      timeoutMs: 20000,
    };
    const lease = {
      rootDir: fs.realpathSync(root),
      socketRoot: fs.realpathSync(path.join(home, '.eliza-worker-ipc')),
      runId: request.runId,
      versionId: 'v1',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
    };

    const controller = new AbortController();
    const pending = runSmithersWorkflow({
      ...request,
      timeoutMs: termination === 'timeout' ? 10000 : 20000,
      signal: controller.signal,
      generate: async () => {
        throw Error('Unexpected model call');
      },
    });
    // Observe rejection immediately while waiting for the real effect/owner.
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    try {
      await until(() => fs.existsSync(ready));
      const owner = await inspectWorkerLease(lease);
      if (owner.state !== 'live') throw Error('Fixture worker not authenticated');
      if (termination === 'crash') process.kill(owner.pid, 'SIGKILL');
      if (termination === 'abort') controller.abort();
      expect(await outcome).toMatchObject({ error: { code: 'WORKFLOW_WORKER_OUTCOME_UNKNOWN' } });
      expect((await inspectWorkerLease(lease)).state).toBe('unknown');
      await expect(
        runSmithersWorkflow({
          ...request,
          generate: async () => {
            throw Error('Duplicate model call');
          },
        })
      ).rejects.toMatchObject({ code: 'WORKFLOW_WORKER_OUTCOME_UNKNOWN' });
      expect(fs.readFileSync(effect, 'utf8')).toBe('effect\n');
    } finally {
      controller.abort();
      await outcome;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  }, 25000);
}
