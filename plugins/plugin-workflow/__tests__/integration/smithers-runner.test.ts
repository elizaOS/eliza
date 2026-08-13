/** Exercises a real smthrs workflow through the isolated elizaOS runner and model bridge. */

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resolveSmithersWorkflowDir,
  runSmithersWorkflow,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinitionResponse } from '../../src/types/index';

const tenantId = `smithers-runner-test-${process.pid}`;
const workflowId = 'real-smthrs-workflow';

const workflow: WorkflowDefinitionResponse = {
  id: workflowId,
  name: 'Real Smithers workflow',
  active: true,
  language: 'tsx',
  source: `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const { Workflow, Task, smithers, outputs } = createSmithers({
  result: z.object({ message: z.string() }),
}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
const agent = globalThis.__elizaSmithers.agent;
export default smithers(() => (
  <Workflow name="integration">
    <Task id="run" output={outputs.result} agent={agent}>Return a message.</Task>
  </Workflow>
));`,
  steps: [{ id: 'run', label: 'Run', kind: 'task', agent: 'elizaOS' }],
  widgets: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  versionId: 'v1',
};

afterAll(async () => {
  await rm(resolveSmithersWorkflowDir(tenantId, workflowId), { recursive: true, force: true });
});

describe('real Smithers runner', () => {
  test('executes TSX, bridges model generation, and streams native events', async () => {
    const modelRequests: unknown[] = [];
    const events: string[] = [];
    const result = await runSmithersWorkflow({
      tenantId,
      workflow,
      runId: `run-${Date.now()}`,
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
    expect(modelRequests).toHaveLength(1);
    expect(events.length).toBeGreaterThan(0);
    expect(result.events.length).toBe(events.length);
    expect(join('.eliza', 'smthrs')).toBe('.eliza/smthrs');
  }, 45_000);
});
