/**
 * Tests for the Capacitor BackgroundRunner JS at
 * `packages/app/ios/App/App/runners/eliza-tasks.js` (Android copy is identical).
 *
 * The runner executes inside Capacitor's sandboxed JSContext at OS wake time.
 * We can't spin up that runtime here, so the test loads the source as text,
 * stubs `addEventListener` + `fetch` + `console`, evaluates it in a fresh
 * scope to extract the `handleWake` function the file installs on globalThis,
 * then exercises that function directly.
 *
 * The same file is read from BOTH the iOS and Android paths; the test that
 * asserts they're identical (`runner-mirror.test.ts`) covers content drift.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// Canonical runner JS source lives under app-core platforms/ — `cap:sync`
// copies it into packages/app/ios + packages/app/android, both of which are
// gitignored. The byte-identical Android copy is under the platforms tree
// too. Test against the canonical iOS copy and assert the Android one
// matches via the runner-mirror test below.
const RUNNER_PATH = path.join(
  __dirname,
  '../../../../packages/app-core/platforms/ios/App/App/runners/eliza-tasks.js'
);

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

interface RunnerSandbox {
  handleWake: (args: unknown) => Promise<unknown>;
  fetchCalls: FetchCall[];
  setFetchResponse: (response: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }) => void;
}

function loadRunner(): RunnerSandbox {
  const source = fs.readFileSync(RUNNER_PATH, 'utf8');
  const fetchCalls: FetchCall[] = [];
  let fetchResponse: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  } = {
    ok: true,
    status: 200,
    json: async () => ({ ranTasks: 0, durationMs: 0, lastWakeFiredAt: 0 }),
  };

  const sandbox: Record<string, unknown> = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Number,
    JSON,
    Buffer,
    Error,
    Math,
    fetch: async (
      url: string,
      init: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      } = {}
    ) => {
      fetchCalls.push({ url, init });
      return fetchResponse;
    },
    addEventListener: () => {},
  };
  // Mirror globalThis so the runner's `globalThis.handleWake = ...` assignment
  // lands in this sandbox.
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: RUNNER_PATH });

  return {
    handleWake: sandbox.handleWake as (args: unknown) => Promise<unknown>,
    fetchCalls,
    setFetchResponse: (response) => {
      fetchResponse = response;
    },
  };
}

const baseArgs = {
  kind: 'refresh' as const,
  deadlineSec: 30,
  deviceSecret: 'secret-abc',
  agentBase: 'http://127.0.0.1:31337',
};

describe('runners/eliza-tasks.js — handleWake', () => {
  let runner: RunnerSandbox;

  beforeEach(() => {
    runner = loadRunner();
  });

  test('exports handleWake on globalThis after evaluation', () => {
    expect(typeof runner.handleWake).toBe('function');
  });

  test('rejects on invalid kind', async () => {
    await expect(runner.handleWake({ ...baseArgs, kind: 'bogus' })).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('kind'),
    });
  });

  test('rejects on invalid deadlineSec', async () => {
    await expect(runner.handleWake({ ...baseArgs, deadlineSec: 0 })).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('deadlineSec'),
    });
    await expect(runner.handleWake({ ...baseArgs, deadlineSec: -5 })).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('deadlineSec'),
    });
  });

  test('rejects on missing deviceSecret', async () => {
    await expect(runner.handleWake({ ...baseArgs, deviceSecret: '' })).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('deviceSecret'),
    });
  });

  test('rejects on missing agentBase', async () => {
    await expect(runner.handleWake({ ...baseArgs, agentBase: '' })).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('agentBase'),
    });
  });

  test('POSTs to /api/internal/wake with bearer auth + correct body', async () => {
    runner.setFetchResponse({
      ok: true,
      status: 200,
      json: async () => ({ ranTasks: 3, durationMs: 120, lastWakeFiredAt: 999 }),
    });
    const result = (await runner.handleWake(baseArgs)) as {
      delivered: boolean;
      ranTasks: number;
      durationMs: number;
      lastWakeFiredAt: number;
    };

    expect(runner.fetchCalls.length).toBe(1);
    const call = runner.fetchCalls[0];
    expect(call.url).toBe('http://127.0.0.1:31337/api/internal/wake');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers?.authorization).toBe('Bearer secret-abc');
    expect(call.init.headers?.['content-type']).toContain('application/json');

    const body = JSON.parse(call.init.body ?? '{}') as { kind: string; deadlineMs: number };
    expect(body.kind).toBe('refresh');
    expect(typeof body.deadlineMs).toBe('number');
    // 30s deadline - ~2.5s buffer = ~27.5s; deadlineMs is absolute, must be in the future.
    expect(body.deadlineMs).toBeGreaterThan(Date.now());

    expect(result).toMatchObject({
      delivered: true,
      ranTasks: 3,
      durationMs: 120,
      lastWakeFiredAt: 999,
    });
  });

  test('trims trailing slash from agentBase before composing URL', async () => {
    await runner.handleWake({ ...baseArgs, agentBase: 'http://127.0.0.1:31337/' });
    expect(runner.fetchCalls[0].url).toBe('http://127.0.0.1:31337/api/internal/wake');
  });

  test('rejects with delivered:false when the wake POST returns non-2xx', async () => {
    runner.setFetchResponse({ ok: false, status: 401, json: async () => ({}) });
    await expect(runner.handleWake(baseArgs)).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('401'),
    });
  });

  test('rejects with delivered:false when the wake POST throws', async () => {
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    const sandbox: Record<string, unknown> = {
      console: { log: () => {}, error: () => {}, warn: () => {} },
      setTimeout,
      Promise,
      Date,
      Number,
      JSON,
      Error,
      Math,
      fetch: () => {
        throw new Error('network down');
      },
      addEventListener: () => {},
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(source, ctx, { filename: RUNNER_PATH });
    const fn = sandbox.handleWake as (args: unknown) => Promise<unknown>;
    await expect(fn(baseArgs)).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('network down'),
    });
  });

  test('rejects when work exceeds the OS deadline (minus buffer)', async () => {
    // deadlineSec=3 → hardDeadlineMs = max(1000, 3000 - 2500) = 1000ms.
    // Fetch never resolves → deadline wins.
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    const sandbox: Record<string, unknown> = {
      console: { log: () => {}, error: () => {}, warn: () => {} },
      setTimeout,
      Promise,
      Date,
      Number,
      JSON,
      Error,
      Math,
      fetch: () => new Promise(() => {}), // never resolves
      addEventListener: () => {},
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(source, ctx, { filename: RUNNER_PATH });
    const fn = sandbox.handleWake as (args: unknown) => Promise<unknown>;
    await expect(fn({ ...baseArgs, deadlineSec: 3 })).rejects.toMatchObject({
      delivered: false,
      error: expect.stringContaining('deadline'),
    });
  });
});

describe('runners/eliza-tasks.js — mirroring', () => {
  test('iOS and Android canonical copies are byte-identical', () => {
    const ios = fs.readFileSync(
      path.join(
        __dirname,
        '../../../../packages/app-core/platforms/ios/App/App/runners/eliza-tasks.js'
      ),
      'utf8'
    );
    const android = fs.readFileSync(
      path.join(
        __dirname,
        '../../../../packages/app-core/platforms/android/app/src/main/assets/runners/eliza-tasks.js'
      ),
      'utf8'
    );
    expect(android).toBe(ios);
  });
});
