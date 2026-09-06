/** Exercises real child-process timeout, cancellation, pipe-drain, and EPIPE boundaries. */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SmithersRunRequest } from '../../src/services/smithers-runtime';
import {
  resolveSmithersBunExecutable,
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
type UnrefTimer = ReturnType<typeof setTimeout> & { unref(): void };

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

async function run(
  mode: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: Record<string, unknown>;
    generate?: SmithersRunRequest['generate'];
    onEvent?: SmithersRunRequest['onEvent'];
  } = {}
) {
  return runSmithersWorkflow({
    tenantId,
    workflow: workflow(),
    runId: `run-${mode}-${Date.now()}`,
    mode: 'manual',
    input: { fixtureMode: mode, ...options.input },
    timeoutMs: options.timeoutMs ?? 20_000,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    generate: options.generate ?? (async () => 'done'),
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
  test('uses the current Bun executable when BUN_BIN is unset', () => {
    delete process.env.BUN_BIN;
    expect(resolveSmithersBunExecutable()).toBe(process.execPath);
  });

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

  test('does not relabel an exited worker as timed out while inherited pipes drain', async () => {
    await expect(
      run('exit-with-inherited-pipe', {
        timeoutMs: 750,
        input: { exitDelayMs: 100 },
      })
    ).rejects.toMatchObject({ code: 'SMTHRS_RESULT_MISSING' });
  });

  test('cancels protocol work when a worker exits during an agent request', async () => {
    const startedAt = Date.now();
    let generationSignal: AbortSignal | undefined;
    await expect(
      run('exit-with-pending-agent-request', {
        generate: ({ signal }) => {
          generationSignal = signal;
          return new Promise((_, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      })
    ).rejects.toMatchObject({ code: 'SMTHRS_RESULT_MISSING' });
    expect(generationSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test('reports spawn failure even when the configured timeout is shorter than drain grace', async () => {
    process.env.BUN_BIN = `${fixturePath}.missing`;
    const startedAt = Date.now();
    await expect(run('ignore-termination', { timeoutMs: 250 })).rejects.toMatchObject({
      code: 'SMTHRS_WORKER_SPAWN_FAILED',
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test('observes a closed stdin while preserving a valid terminal result', async () => {
    const result = await run('closed-input-result');
    expect(result.status).toBe('finished');
  });

  test('preserves a terminal result when durable event delivery exceeds pipe drain grace', async () => {
    const delivered: string[] = [];
    const result = await run('event-before-result', {
      onEvent: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        delivered.push(event.type);
      },
    });

    expect(result.status).toBe('finished');
    expect(delivered).toEqual(['TaskStarted']);
    expect(result.events.map((event) => event.type)).toEqual(['TaskStarted']);
  });

  test('observes an immediate event delivery rejection before child outcome settles', async () => {
    const deliveryError = new Error('immediate event delivery rejection');
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      if (reason === deliveryError) unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await expect(
        run('event-before-result', {
          onEvent: () => Promise.reject(deliveryError),
        })
      ).rejects.toBe(deliveryError);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  test('times out when event delivery does not settle after the worker exits', async () => {
    const startedAt = Date.now();
    const workflowOutcome = run('event-before-result', {
      timeoutMs: 3_000,
      onEvent: () => new Promise(() => {}),
    }).then(
      (value) => ({ kind: 'result' as const, value }),
      (error) => ({ kind: 'error' as const, error })
    );
    let watchdogTimer: UnrefTimer | undefined;
    const watchdogOutcome = new Promise<{ kind: 'watchdog' }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'watchdog' }), 5_000) as unknown as UnrefTimer;
      timer.unref();
      watchdogTimer = timer;
    });
    try {
      const outcome = await Promise.race([workflowOutcome, watchdogOutcome]);

      expect(outcome).toMatchObject({
        kind: 'error',
        error: { code: 'SMTHRS_WORKFLOW_TIMEOUT' },
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
    }
  });

  test('cancels when event delivery does not settle after the worker exits', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const startedAt = Date.now();
    const workflowOutcome = run('event-before-result', {
      signal: controller.signal,
      timeoutMs: 3_000,
      onEvent: () => new Promise(() => {}),
    });
    let watchdogTimer: UnrefTimer | undefined;
    const watchdogOutcome = new Promise<{ status: 'watchdog' }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ status: 'watchdog' }),
        2_000
      ) as unknown as UnrefTimer;
      timer.unref();
      watchdogTimer = timer;
    });
    try {
      const outcome = await Promise.race([workflowOutcome, watchdogOutcome]);

      expect(outcome.status).toBe('cancelled');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
    }
  });

  test('terminates a worker whose stdout line exceeds the protocol budget', async () => {
    await expect(
      run('oversized-stdout-line', {
        input: { outputBytes: 1_048_576 },
      })
    ).rejects.toMatchObject({ code: 'SMTHRS_RESULT_MISSING' });

    await expect(
      run('oversized-stdout-line', {
        input: { outputBytes: 1_048_577 },
      })
    ).rejects.toMatchObject({ code: 'SMTHRS_PROTOCOL_OVERFLOW' });
  });
});
