/** Integration test that spawns the smithers-runtime fixture as a child process and asserts on its real Smithers execution output. */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASE_TIMEOUT_MS = 45_000;
const fixturePath = fileURLToPath(new URL('../fixtures/smithers-runtime-case.ts', import.meta.url));
const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));

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

async function runCase(caseName: string): Promise<CaseRunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'smithers-runtime-case-'));
  const resultPath = join(tempDir, `${caseName}.json`);
  const proc = spawn(process.env.BUN_BIN || 'bun', ['run', fixturePath, caseName], {
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
});
