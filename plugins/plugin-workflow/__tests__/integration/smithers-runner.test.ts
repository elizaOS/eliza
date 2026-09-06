/**
 * Exercises a real smthrs workflow through the isolated elizaOS runner and
 * model bridge, including durable output and child-resource teardown.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
    expect(retainedFiles).toContain(`${workflow.versionId}.tsx`);
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
});
