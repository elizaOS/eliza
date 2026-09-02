/**
 * Exercises a real smthrs workflow through the isolated elizaOS runner and
 * model bridge, including durable output and child-resource teardown.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resolveSmithersWorkflowDir,
  runSmithersWorkflow,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinitionResponse } from '../../src/types/index';

const tenantId = `smithers-runner-test-${process.pid}`;
const workflowId = 'real-smthrs-workflow';
const finiteWorkflowId = 'finite-retry-workflow';

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
    [workflowId, finiteWorkflowId].map((id) =>
      rm(resolveSmithersWorkflowDir(tenantId, id), {
        recursive: true,
        force: true,
      })
    )
  );
});

describe('real Smithers runner', () => {
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
