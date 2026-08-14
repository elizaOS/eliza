/** Exercises real child-process timeout, cancellation, pipe-drain, and EPIPE boundaries. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSmithersWorkflowDir,
  runSmithersWorkflow,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinitionResponse } from '../../src/types/index';

const tenantId = `smithers-worker-lifecycle-${process.pid}`;
const workflowId = 'lifecycle-fixture';
const fixturePath = fileURLToPath(
  new URL('../fixtures/smithers-worker-lifecycle-fixture.mjs', import.meta.url)
);
const originalBunBin = process.env.BUN_BIN;

function workflow(): WorkflowDefinitionResponse {
  const now = new Date().toISOString();
  return {
    id: workflowId,
    name: 'Lifecycle fixture',
    active: true,
    language: 'ts',
    source:
      "import { createSmithers } from 'smthrs/create'; export default createSmithers({}, {}).smithers(() => null);",
    steps: [],
    widgets: [],
    createdAt: now,
    updatedAt: now,
    versionId: 'v1',
  };
}

async function run(mode: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  return runSmithersWorkflow({
    tenantId,
    workflow: workflow(),
    runId: `run-${mode}-${Date.now()}`,
    mode: 'manual',
    input: { fixtureMode: mode },
    timeoutMs: options.timeoutMs ?? 20_000,
    ...(options.signal ? { signal: options.signal } : {}),
    generate: async () => 'done',
  });
}

beforeAll(async () => {
  await chmod(fixturePath, 0o755);
  process.env.BUN_BIN = fixturePath;
});

afterEach(() => {
  process.env.BUN_BIN = fixturePath;
});

afterAll(async () => {
  if (originalBunBin === undefined) delete process.env.BUN_BIN;
  else process.env.BUN_BIN = originalBunBin;
  await rm(dirname(resolveSmithersWorkflowDir(tenantId, workflowId)), {
    recursive: true,
    force: true,
  });
});

describe('Smithers worker lifecycle', () => {
  test('escalates an ignored timeout and reports the typed timeout', async () => {
    const startedAt = Date.now();
    await expect(run('ignore-termination', { timeoutMs: 250 })).rejects.toMatchObject({
      code: 'SMTHRS_WORKFLOW_TIMEOUT',
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test('escalates an ignored abort and returns cancelled state', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const startedAt = Date.now();
    const result = await run('ignore-termination', { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test('does not wait forever when a descendant inherits the worker pipes', async () => {
    const startedAt = Date.now();
    await expect(run('exit-with-inherited-pipe')).rejects.toMatchObject({
      code: 'SMTHRS_RESULT_MISSING',
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test('observes a closed stdin while preserving a valid terminal result', async () => {
    const result = await run('closed-input-result');
    expect(result.status).toBe('finished');
  });
});
