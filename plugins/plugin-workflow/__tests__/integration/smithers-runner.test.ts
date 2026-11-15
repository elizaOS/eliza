/**
 * Exercises a real smthrs workflow through the isolated elizaOS runner and
 * model bridge, including durable output and child-resource teardown.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isPidAlive, parseRuntimeOwnerPid } from '@smthrs/engine/runtime-owner';
import {
  controlSmithersRun,
  resolveSmithersWorkflowDir,
  runSmithersWorkflow,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinitionResponse } from '../../src/types/index';

const tenantId = `smithers-runner-test-${process.pid}`;
const workflowId = 'real-smthrs-workflow';
const finiteWorkflowId = 'finite-retry-workflow';
const dependentWorkflowId = 'dependent-task-workflow';
const invalidWorkflowId = 'invalid-render-workflow';
const approvalWorkflowId = 'approval-resume-workflow';
const signalWorkflowId = 'signal-resume-workflow';

const workflow: WorkflowDefinitionResponse = {
  id: workflowId,
  name: 'Real Smithers workflow',
  active: true,
  language: 'tsx',
  source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const { Workflow, Task, smithers, outputs } = createSmithers({
  output: z.object({ message: z.string() }),
}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
const agent = globalThis.__elizaSmithers.agent;
export default smithers(() => (
  <Workflow name="integration">
    <Task id="run" output={outputs.output} agent={agent}>Return a message.</Task>
  </Workflow>
));`,
  steps: [{ id: 'run', label: 'Run', kind: 'task', agent: 'elizaOS' }],
  widgets: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  versionId: 'v1',
};

afterAll(async () => {
  await Promise.all(
    [
      workflowId,
      finiteWorkflowId,
      dependentWorkflowId,
      invalidWorkflowId,
      approvalWorkflowId,
      signalWorkflowId,
    ].map((id) =>
      rm(resolveSmithersWorkflowDir(tenantId, id), {
        recursive: true,
        force: true,
      })
    )
  );
});

describe('real Smithers runner', () => {
  test('resumes a persisted approval without running the guarded task early', async () => {
    const definition: WorkflowDefinitionResponse = {
      ...workflow,
      id: approvalWorkflowId,
      source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { approvalDecisionSchema } from "smthrs";
import { z } from "zod";
const { Workflow, Sequence, Approval, Task, smithers, outputs } = createSmithers({decision: approvalDecisionSchema, output: z.object({message: z.string()})}, {dbPath: process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(() => <Workflow name="approval"><Sequence><Approval id="publish-gate" output={outputs.decision} request={{title:"Publish the reviewed result?"}} /><Task id="publish" output={outputs.output} agent={globalThis.__elizaSmithers.agent}>Publish the reviewed result.</Task></Sequence></Workflow>);`,
    };
    let calls = 0;
    const request = {
      tenantId,
      workflow: definition,
      runId: `approval-${Date.now()}`,
      mode: 'manual' as const,
      input: {},
      timeoutMs: 60000,
      generate: async () => {
        calls += 1;
        return '{"message":"Published after approval"}';
      },
    };
    const paused = await runSmithersWorkflow(request);
    expect(paused.status).toBe('waiting-approval');
    expect(calls).toBe(0);
    const iteration = paused.events.find(
      (event) => event.nodeId === 'publish-gate' && typeof event.iteration === 'number'
    )?.iteration;
    if (iteration === undefined)
      throw new Error('Approval event must identify its durable iteration');
    await controlSmithersRun(tenantId, approvalWorkflowId, {
      kind: 'approve',
      runId: request.runId,
      nodeId: 'publish-gate',
      iteration,
    });
    const finished = await runSmithersWorkflow(request);
    expect(finished.status, JSON.stringify(finished.error)).toBe('finished');
    expect(finished.output).toEqual([
      expect.objectContaining({
        message: 'Published after approval',
        nodeId: 'publish',
        runId: request.runId,
      }),
    ]);
    expect(calls).toBe(1);
  }, 150000);

  test('resumes a persisted signal wait with the complete external payload', async () => {
    const definition: WorkflowDefinitionResponse = {
      ...workflow,
      id: signalWorkflowId,
      source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const { Workflow, Signal, Task, smithers, outputs } = createSmithers({signal: z.object({message:z.string()}), output: z.object({message:z.string()})}, {dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(() => <Workflow name="signal"><Signal id="review-ready" schema={outputs.signal}>{data => <Task id="publish" output={outputs.output} agent={globalThis.__elizaSmithers.agent}>{data.message}</Task>}</Signal></Workflow>);`,
    };
    const prompts: unknown[] = [];
    const message = `Signal payload 🟠 ${'preserved '.repeat(2000)}complete`;
    const request = {
      tenantId,
      workflow: definition,
      runId: `signal-${Date.now()}`,
      mode: 'manual' as const,
      input: {},
      timeoutMs: 60000,
      generate: async (prompt: unknown) => {
        prompts.push(prompt);
        return '{"message":"Signal consumed"}';
      },
    };
    const waiting = await runSmithersWorkflow(request);
    expect(waiting.status, JSON.stringify(waiting.error)).toBe('waiting-event');
    expect(prompts).toHaveLength(0);
    await controlSmithersRun(tenantId, signalWorkflowId, {
      kind: 'signal',
      runId: request.runId,
      signal: 'review-ready',
      payload: { message },
    });
    const finished = await runSmithersWorkflow(request);
    expect(finished.status, JSON.stringify(finished.error)).toBe('finished');
    expect(finished.output).toEqual([
      expect.objectContaining({
        message: 'Signal consumed',
        nodeId: 'publish',
        runId: request.runId,
      }),
    ]);
    expect(JSON.stringify(prompts)).toContain(message);
  }, 150000);

  test('passes complete persisted output into a dependent task and resumes without replay', async () => {
    const completeMessage = `start-${'workflow context 🟠 '.repeat(4_000)}-end`;
    const dependentWorkflow: WorkflowDefinitionResponse = {
      ...workflow,
      id: dependentWorkflowId,
      source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const { Workflow, Task, smithers, outputs } = createSmithers({
  draft: z.object({ message: z.string() }),
  output: z.object({ message: z.string() }),
}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
const agent = globalThis.__elizaSmithers.agent;
export default smithers(() => (
  <Workflow name="dependent-output">
    <Task id="draft" output={outputs.draft} agent={agent}>Draft the result.</Task>
    <Task id="review" output={outputs.output} agent={agent} deps={{ draft: outputs.draft }}>
      {({ draft }) => draft.message}
    </Task>
  </Workflow>
));`,
      steps: [
        { id: 'draft', label: 'Draft', kind: 'task', agent: 'elizaOS' },
        { id: 'review', label: 'Review', kind: 'task', agent: 'elizaOS' },
      ],
    };
    const prompts: unknown[] = [];
    const request = {
      tenantId,
      workflow: dependentWorkflow,
      runId: `dependent-${Date.now()}`,
      mode: 'manual' as const,
      input: {},
      timeoutMs: 20_000,
      generate: async ({ prompt }: { prompt: unknown }) => {
        prompts.push(prompt);
        return { message: prompts.length === 1 ? completeMessage : 'reviewed' };
      },
    };
    const result = await runSmithersWorkflow(request);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('finished');
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain(completeMessage);
    expect(result.output).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'reviewed' })])
    );

    const resumed = await runSmithersWorkflow(request);
    expect(resumed.status).toBe('finished');
    expect(prompts).toHaveLength(2);
    const database = new Database(
      join(resolveSmithersWorkflowDir(tenantId, dependentWorkflowId), 'runs.sqlite')
    );
    try {
      expect(
        database
          .query<{ message: string }, [string]>('SELECT message FROM draft WHERE run_id = ?')
          .all(request.runId)
      ).toEqual([{ message: completeMessage }]);
      expect(
        database
          .query<{ message: string }, [string]>('SELECT message FROM output WHERE run_id = ?')
          .all(request.runId)
      ).toEqual([{ message: 'reviewed' }]);
    } finally {
      database.close();
    }
  }, 60_000);

  test('preserves actionable native render errors across the worker protocol', async () => {
    const result = await runSmithersWorkflow({
      tenantId,
      workflow: {
        ...workflow,
        id: invalidWorkflowId,
        source: `import { createSmithers } from "smthrs/create";
import { z } from "zod";
const { smithers } = createSmithers({ output: z.object({ message: z.string() }) },
  { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
export default smithers(() => { throw new Error("Select a project before running review"); });`,
      },
      runId: `invalid-render-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 20_000,
      generate: async () => {
        throw new Error('A failed render must not invoke the model');
      },
    });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('Select a project before running review');
  }, 45_000);

  test('executes TSX, bridges model generation, and streams native events', async () => {
    const modelRequests: unknown[] = [];
    const events: string[] = [];
    const runId = `run-${Date.now()}`;
    const result = await runSmithersWorkflow({
      tenantId,
      workflow,
      runId,
      mode: 'manual',
      input: { request: 'hello' },
      timeoutMs: 20_000,
      generate: async (request) => {
        modelRequests.push(request);
        return { message: 'done' };
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    expect(result.status).toBe('finished');
    expect(result.output).toEqual([expect.objectContaining({ message: 'done' })]);
    expect(modelRequests).toHaveLength(1);
    expect(events.length).toBeGreaterThan(0);
    expect(result.events.length).toBe(events.length);

    const workflowDir = resolveSmithersWorkflowDir(tenantId, workflowId);
    const databasePath = join(workflowDir, 'runs.sqlite');
    expect((await stat(databasePath)).isFile()).toBe(true);

    const database = new Database(databasePath);
    try {
      const persistedRun = database
        .query<{ finishedAtMs: number; status: string }, [string]>(
          `SELECT finished_at_ms AS finishedAtMs, status
             FROM _smithers_runs
            WHERE run_id = ?`
        )
        .get(runId);
      expect(persistedRun).toEqual({ finishedAtMs: expect.any(Number), status: 'finished' });

      const persistedOutput = database
        .query<{ message: string }, [string, string]>(
          `SELECT message
             FROM "output"
            WHERE run_id = ? AND node_id = ?`
        )
        .get(runId, 'run');
      expect(persistedOutput).toEqual({ message: 'done' });

      // The runner resolves only after the child exits; taking a write lock
      // proves its SQLite connection has also released the durable store.
      database.exec('BEGIN IMMEDIATE');
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }

    const retainedFiles = await readdir(workflowDir);
    const sourceName = `${workflow.versionId}.${createHash('sha256').update(workflow.source).digest('hex')}.tsx`;
    expect(retainedFiles).toContain(sourceName);
    expect(await readFile(join(workflowDir, sourceName), 'utf8')).toBe(workflow.source);
    expect(retainedFiles.filter((name) => name.startsWith('.run-'))).toEqual([]);
  }, 45_000);

  test('extracts fenced structured text through the Smithers fallback', async () => {
    const requests: unknown[] = [];
    const result = await runSmithersWorkflow({
      tenantId,
      workflow,
      runId: `fenced-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 20_000,
      generate: async (request) => {
        requests.push(request);
        return '```json\n{"message":"fenced"}\n```';
      },
    });

    expect(result.status).toBe('finished');
    expect(result.output).toEqual([expect.objectContaining({ message: 'fenced' })]);
    expect(requests).toHaveLength(1);
  }, 45_000);

  test('honors a finite task retry budget for malformed output', async () => {
    let requests = 0;
    const finiteWorkflow: WorkflowDefinitionResponse = {
      ...workflow,
      id: finiteWorkflowId,
      versionId: 'finite-v1',
      source: workflow.source.replace(
        'id="run" output={outputs.output} agent={agent}',
        'id="run" output={outputs.output} agent={agent} retries={1} maxSchemaRetries={0}'
      ),
    };
    const result = await runSmithersWorkflow({
      tenantId,
      workflow: finiteWorkflow,
      runId: `malformed-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 20_000,
      generate: async () => {
        requests += 1;
        return 'not json';
      },
    });

    expect(result.status).toBe('failed');
    expect(requests).toBe(2);
    expect(result.events.filter((event) => event.type === 'NodeRetrying')).toHaveLength(1);
  }, 45_000);

  test('bridges a model reply that contains Unicode line and paragraph separators', async () => {
    // TEXT_LARGE returns plain text, and a model can copy U+2028/U+2029 from
    // the content it reads. The worker reads its responses line by line.
    const message = 'Line one\u2028Line two\u2029Line three';
    let requests = 0;
    const result = await runSmithersWorkflow({
      tenantId,
      workflow,
      runId: `separators-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 20_000,
      generate: async () => {
        requests += 1;
        return JSON.stringify({ message });
      },
    });

    expect(result.error?.message).toBeUndefined();
    expect(result.status).toBe('finished');
    expect(result.output).toEqual([expect.objectContaining({ message })]);
    expect(requests).toBe(1);
  }, 45_000);
});

test('preserves the complete native finish receipt when abort releases pending event delivery', async () => {
  const id = 'native-finish-before-host-abort';
  const runId = `finish-abort-${Date.now()}`;
  const definition = { ...workflow, id };
  const dir = resolveSmithersWorkflowDir(tenantId, id);
  const controller = new AbortController();
  let nativeFinished!: () => void;
  const committed = new Promise<void>((resolve) => {
    nativeFinished = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ownerPid: number | null = null;
  let nativeStatus: unknown;
  const outcome = runSmithersWorkflow({
    tenantId,
    workflow: definition,
    runId,
    mode: 'manual',
    input: {},
    signal: controller.signal,
    generate: async () => '{"message":"Exact durable output 🟠"}',
    onEvent: async (event) => {
      if (event.type === 'RunStarted' || event.type === 'RunFinished') {
        const db = new Database(join(dir, 'runs.sqlite'), { readonly: true });
        try {
          const row = db
            .query('SELECT status, runtime_owner_id FROM _smithers_runs WHERE run_id=?')
            .get(runId) as { status: string; runtime_owner_id: string | null };
          if (event.type === 'RunStarted') ownerPid = parseRuntimeOwnerPid(row.runtime_owner_id);
          else {
            nativeStatus = row.status;
            nativeFinished();
            await held;
          }
        } finally {
          db.close();
        }
      }
    },
  });
  try {
    await committed;
    expect(nativeStatus).toBe('finished');
    expect(ownerPid).not.toBeNull();
    for (let n = 0; n < 500 && isPidAlive(ownerPid!); n++) await Bun.sleep(10);
    expect(isPidAlive(ownerPid!)).toBe(false);
    controller.abort();
    const result = await outcome;
    expect(result.status).toBe('finished');
    expect(result.output).toEqual([
      expect.objectContaining({ message: 'Exact durable output 🟠' }),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.events.some((event) => event.type === 'RunFinished')).toBe(true);
  } finally {
    release();
    controller.abort();
    await outcome.catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

describe('worker protocol settles promptly and truthfully', () => {
  const definition = (id: string, source: string): WorkflowDefinitionResponse => ({
    ...workflow,
    id,
    source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
import * as fs from "node:fs";
const { Workflow, Parallel, Task, smithers, outputs } = createSmithers({
  a: z.object({ message: z.string() }),
  b: z.object({ message: z.string() }),
  output: z.object({ message: z.string() }),
}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
const agent = globalThis.__elizaSmithers.agent;
${source}`,
  });
  const parallel = `export default smithers(() => (
  <Workflow name="parallel"><Parallel>
    <Task id="a" output={outputs.a} agent={agent}>Task alpha.</Task>
    <Task id="b" output={outputs.b} agent={agent}>Task beta.</Task>
  </Parallel></Workflow>
));`;
  const hangUntilAborted = (signal: AbortSignal) =>
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    );
  const ids: string[] = [];
  const workflowFor = (name: string, source: string) => {
    const id = `protocol-${name}`;
    ids.push(id);
    return definition(id, source);
  };
  afterAll(async () => {
    await Promise.all(
      ids.map((id) =>
        rm(resolveSmithersWorkflowDir(tenantId, id), { recursive: true, force: true })
      )
    );
  });

  test('answers parallel model requests concurrently', async () => {
    let calls = 0;
    const result = await runSmithersWorkflow({
      tenantId,
      workflow: workflowFor('parallel', parallel),
      runId: `parallel-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 60_000,
      generate: async () => {
        calls += 1;
        // A serialized bridge never delivers the second request while this waits.
        for (let n = 0; calls < 2 && n < 1_500; n++) await Bun.sleep(10);
        if (calls < 2) throw new Error('requests were serialized');
        return { message: 'concurrent' };
      },
    });
    expect(result.status, JSON.stringify(result.error)).toBe('finished');
    expect(calls).toBe(2);
  }, 90_000);

  test('stops the worker at once when an event cannot be persisted', async () => {
    let calls = 0;
    const startedAt = Date.now();
    const outcome = runSmithersWorkflow({
      tenantId,
      workflow: workflowFor('delivery', parallel),
      runId: `delivery-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 120_000,
      // The first task's model call stays pending; the other task's events
      // then fail to persist.
      generate: async ({ signal }) => {
        calls += 1;
        if (calls === 1) return hangUntilAborted(signal);
        return { message: 'second' };
      },
      onEvent: () => {
        if (calls === 2) throw new Error('database unavailable');
      },
    });
    await expect(outcome).rejects.toMatchObject({
      code: 'WORKFLOW_WORKER_OUTCOME_UNKNOWN',
      message: expect.stringContaining('event persistence failed: database unavailable'),
    });
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  }, 90_000);

  test('returns a terminal result that arrived before a delivery failure', async () => {
    const result = await runSmithersWorkflow({
      tenantId,
      workflow: workflowFor(
        'late-delivery',
        `export default smithers(() => (<Workflow name="late"><Task id="run" output={outputs.output} agent={agent}>Return a message.</Task></Workflow>));`
      ),
      runId: `late-delivery-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 60_000,
      generate: async () => ({ message: 'committed' }),
      onEvent: async (event) => {
        if (event.type !== 'RunFinished') return;
        // Let the worker commit, report and exit before persistence fails.
        await Bun.sleep(3_000);
        throw new Error('database unavailable');
      },
    });
    expect(result.status).toBe('finished');
    expect(result.output).toEqual([expect.objectContaining({ message: 'committed' })]);
  }, 90_000);

  test('releases the lease when the workflow module fails to load', async () => {
    const failing = workflowFor(
      'import-failure',
      `throw new Error("module exploded at import");
export default smithers(() => (<Workflow name="never"><Task id="run" output={outputs.output} agent={agent}>x</Task></Workflow>));`
    );
    const request = {
      tenantId,
      workflow: failing,
      runId: `import-failure-${Date.now()}`,
      mode: 'manual' as const,
      input: {},
      timeoutMs: 60_000,
      generate: async () => {
        throw new Error('A module that failed to load must not invoke the model');
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runSmithersWorkflow(request);
      expect(result.status).toBe('failed');
      expect(result.error?.message).toContain('module exploded at import');
    }
    const owners = join(resolveSmithersWorkflowDir(tenantId, failing.id), '.worker-owners');
    expect(await readdir(owners)).toEqual([]);
  }, 90_000);

  test('a host timeout after admission says the agent stopped the run', async () => {
    const outcome = runSmithersWorkflow({
      tenantId,
      workflow: workflowFor(
        'timeout',
        `export default smithers(() => (<Workflow name="slow"><Task id="run" output={outputs.output} agent={agent}>Wait.</Task></Workflow>));`
      ),
      runId: `timeout-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 15_000,
      generate: async ({ signal }) => hangUntilAborted(signal),
    });
    await expect(outcome).rejects.toMatchObject({
      code: 'WORKFLOW_WORKER_OUTCOME_UNKNOWN',
      message: expect.stringContaining(
        'The agent stopped this run (timed out after 15 s) before it reported a result. Nothing was replayed.'
      ),
      context: { terminationCause: 'timeout' },
    });
  }, 90_000);

  test('a pending device review does not spend the run time budget', async () => {
    const result = await runSmithersWorkflow({
      tenantId,
      workflow: workflowFor(
        'device',
        `const reviewer = { id: "device-review", generate: async () => {
  const reply = await globalThis.__elizaSmithers.device({ kind: "review" });
  return { text: JSON.stringify({ message: String(reply) }) };
} };
export default smithers(() => (<Workflow name="device"><Task id="run" output={outputs.output} agent={reviewer}>Review.</Task></Workflow>));`
      ),
      runId: `device-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 15_000,
      generate: async () => {
        throw new Error('The device fixture does not call the model');
      },
      device: async () => {
        await Bun.sleep(20_000);
        return 'approved';
      },
    });
    expect(result.status, JSON.stringify(result.error)).toBe('finished');
    expect(result.output).toEqual([expect.objectContaining({ message: 'approved' })]);
  }, 90_000);

  test('keeps only the last 64 KiB of worker stderr', async () => {
    // The fixture drops its own reservation and dies, so the parent reports
    // the missing result with its stderr.
    const failing = workflowFor(
      'stderr',
      `const payload = JSON.parse(fs.readFileSync(process.env.ELIZA_SMTHRS_PAYLOAD_PATH, "utf8"));
const owners = payload.workerLease.rootDir + "/.worker-owners/" + new Bun.CryptoHasher("sha256").update(payload.runId).digest("hex");
fs.rmSync(owners, { recursive: true, force: true });
fs.writeSync(2, "HEAD-MARKER" + "x".repeat(200_000) + "TAIL-MARKER\\n");
process.exit(3);
export default smithers(() => (<Workflow name="never"><Task id="run" output={outputs.output} agent={agent}>x</Task></Workflow>));`
    );
    const outcome = runSmithersWorkflow({
      tenantId,
      workflow: failing,
      runId: `stderr-${Date.now()}`,
      mode: 'manual',
      input: {},
      timeoutMs: 60_000,
      generate: async () => {
        throw new Error('unused');
      },
    });
    const error = await outcome.then(
      () => undefined,
      (failure: unknown) => failure as { code?: string; message: string }
    );
    expect(error?.code).toBe('SMTHRS_RESULT_MISSING');
    expect(error?.message).toContain('TAIL-MARKER');
    expect(error?.message).not.toContain('HEAD-MARKER');
    expect(error?.message.length).toBeLessThan(70_000);
  }, 90_000);
});
