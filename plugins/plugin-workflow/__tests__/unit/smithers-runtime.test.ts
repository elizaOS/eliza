/** Integration test that spawns smithers-runtime fixtures and asserts on real subprocess execution and failure output. */
import { describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_TIMEOUT_MS = 45_000;
const fixturePath = fileURLToPath(new URL('../fixtures/smithers-runtime-case.ts', import.meta.url));
const earlyCloseFixturePath = fileURLToPath(
  new URL('../fixtures/smithers-early-close-case.ts', import.meta.url)
);
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const coreKeywordDataPath = fileURLToPath(
  new URL(
    '../../../../packages/core/src/i18n/generated/validation-keyword-data.ts',
    import.meta.url
  )
);
const keywordGeneratorPath = fileURLToPath(
  new URL('../../../../packages/shared/scripts/generate-keywords.mjs', import.meta.url)
);

// The changed-file coverage lane resolves workspace packages from source before
// any package build, so create the same gitignored keyword module required by
// every other source-mode CI lane.
if (!existsSync(coreKeywordDataPath)) {
  const generation = spawnSync(process.env.NODE_BIN ?? 'node', [keywordGeneratorPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (generation.status !== 0) {
    throw new Error(
      `Failed to generate source-mode keyword data.\nstdout:\n${generation.stdout}\nstderr:\n${generation.stderr}`
    );
  }
}

interface CaseRunResult {
  stdout: string;
  stderr: string;
  result: Record<string, unknown>;
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (
      normalized === 'NODE_V8_COVERAGE' ||
      normalized === 'BUN_TEST' ||
      normalized.startsWith('BUN_TEST_') ||
      normalized.startsWith('VITEST') ||
      normalized.startsWith('NYC_') ||
      normalized.includes('COVERAGE')
    ) {
      delete env[key];
    }
  }
  return env;
}

async function runCase(
  caseName: string,
  selectedFixture = fixturePath,
  runner: 'bun' | 'node' = 'bun'
): Promise<CaseRunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'smithers-runtime-case-'));
  const resultPath = join(tempDir, `${caseName}.json`);
  const command =
    runner === 'node' ? (process.env.NODE_BIN ?? 'node') : (process.env.BUN_BIN ?? 'bun');
  const args =
    runner === 'node'
      ? ['--conditions=eliza-source', '--import', 'tsx', selectedFixture, caseName]
      : ['--conditions=eliza-source', 'run', selectedFixture, caseName];
  const proc = spawn(command, args, {
    cwd: pluginRoot,
    env: { ...buildChildEnv(), SMITHERS_RUNTIME_CASE_OUTPUT: resultPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, CASE_TIMEOUT_MS);

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 1));
  }).finally(() => clearTimeout(timeout));

  if (timedOut) {
    await rm(tempDir, { force: true, recursive: true });
    throw new Error(
      `Smithers runtime case "${caseName}" timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  if (exitCode !== 0) {
    await rm(tempDir, { force: true, recursive: true });
    throw new Error(
      `Smithers runtime case "${caseName}" failed with exit ${exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }

  const resultJson = await readFile(resultPath, 'utf8').catch(() => '');
  if (!resultJson) {
    await rm(tempDir, { force: true, recursive: true });
    throw new Error(
      `Smithers runtime case "${caseName}" did not report a result.\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  await rm(tempDir, { force: true, recursive: true });

  return {
    stdout,
    stderr,
    result: JSON.parse(resultJson) as Record<string, unknown>,
  };
}

describe('runWorkflowWithSmithers (in-process Smithers engine)', () => {
  it('runs independent nodes as a parallel level and routes data through the DAG', async () => {
    const { result } = await runCase('fanout');

    expect(result.status).toBe('success');
    expect(result.finished).toBe(true);
    expect(result.calls).toEqual(['A', 'B', 'C', 'trigger']);
    expect(result.lastNodeExecuted).toBe('C');
    expect(result.cInput0).toEqual({ node: 'A' });
    expect(result.cInput1).toEqual({ node: 'B' });
    expect(result.engine).toMatchObject({
      provider: 'smithers',
      nodes: 4,
      levels: 3,
      maxConcurrency: 2,
    });
  }, 60_000);

  it('retries a node according to its n8n retryOnFail / maxTries settings', async () => {
    const { result } = await runCase('retry');

    expect(result.attempts).toBe(2);
    expect(result.status).toBe('success');
    expect(result.retries).toBe(1);
  }, 60_000);

  it('continues and emits an error item when a node sets continueOnFail', async () => {
    const { result } = await runCase('continue');

    expect(result.status).toBe('success');
    expect(result.errorItem).toBe('boom');
  }, 60_000);

  it('fails the run when a node throws without retry or continueOnFail', async () => {
    const { result } = await runCase('fail');

    expect(result.threw).toBe(true);
    expect(String(result.message)).toContain('fatal');
  }, 60_000);

  it('kills a stalled workflow at the configured execution deadline', async () => {
    const { result } = await runCase('timeout');

    expect(result.threw).toBe(true);
    expect(result.code).toBe('SMITHERS_WORKFLOW_TIMEOUT');
  }, 60_000);

  it('cancels parent node work before an aborted run can produce a late side effect', async () => {
    const { result } = await runCase('timeout-cancellation');

    expect(result.code).toBe('SMITHERS_WORKFLOW_ABORTED');
    expect(result.nodeWorkStarted).toBe(true);
    expect(result.observedAbort).toBe(true);
    expect(result.sideEffectHappened).toBe(false);
  }, 60_000);

  it('delivers workflow results larger than the subprocess pipe buffer without truncation', async () => {
    const { result } = await runCase('large-result');

    expect(result.status).toBe('success');
    expect(result.payloadLength).toBe(1024 * 1024);
    expect(result.payloadSuffix).toBe('smithers-large-result');
  }, 60_000);

  it('fails promptly and leaves no orphan when a live worker closes its payload pipe', async () => {
    const { result } = await runCase('early-child-close', earlyCloseFixturePath, 'node');

    expect(result.threw).toBe(true);
    expect(result.code).toBe('SMITHERS_WORKFLOW_FAILED');
    expect(result.phase).toBe('payload');
    expect(result.exitCode).toBe(1);
    expect(result.causeCode).toBe('EPIPE');
    expect(String(result.message)).toContain('smithers child exited before payload');
    expect(String(result.message)).not.toContain('redaction-sentinel-redaction-sentinel');
    expect(String(result.message).length).toBeLessThan(4_300);
    expect(Number(result.elapsedMs)).toBeLessThan(2_000);
    expect(result.workerKilled).toBe(true);
    expect(result.workerClosed).toBe(true);
    expect(result.workerAlive).toBe(false);
  }, 60_000);

  it('settles and terminates when the payload stream closes without an error event', async () => {
    const { result } = await runCase('close-without-error', earlyCloseFixturePath, 'node');

    expect(result.threw).toBe(true);
    expect(result.code).toBe('SMITHERS_WORKFLOW_FAILED');
    expect(result.phase).toBe('payload');
    expect(result.exitCode).toBe(1);
    expect(result.causeCode).toBe('ERR_STREAM_PREMATURE_CLOSE');
    expect(String(result.message)).toMatch(
      /payload (?:stream closed without error|pipe closed before write completed)/
    );
    expect(String(result.message)).not.toContain('redaction-sentinel-redaction-sentinel');
    expect(Number(result.elapsedMs)).toBeLessThan(2_000);
    expect(result.workerKilled).toBe(true);
    expect(result.workerClosed).toBe(true);
    expect(result.workerAlive).toBe(false);
  }, 60_000);

  it('resumes after a crash without repeating an already-persisted side effect', async () => {
    const { result } = await runCase('crash-resume');

    expect(result.status).toBe('success');
    expect(result.sideEffectCalls).toBe(1);
    expect(result.firstCalls).toEqual(['side-effect', 'consumer']);
    expect(result.resumedCalls).toEqual(['consumer']);
    expect(result.resumedInput).toEqual({ durableToken: 'created-once' });
    expect(result.persistedNodes).toEqual(['consumer', 'side-effect']);
    expect(result.engine).toMatchObject({
      provider: 'smithers',
      nodes: 2,
      started: 2,
      finished: 2,
    });
  }, 60_000);
});
