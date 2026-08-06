import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentVerifier } from './verify.js';

/**
 * Focused on synchronous safety/config checks. Optional live provider reachability
 * is skipped unless its API key is present.
 */

const ENV_KEYS = [
  'LIVE_TRADING',
  'OPERATOR_CONFIRMED',
  'PERPS_SIM_ONLY',
  'ZAI_API_KEY',
  'XAI_API_KEY',
  'HELIUS_RPC_URL',
  'SOLANA_RPC_URL',
  'IMPERIAL_ENABLED',
  'IMPERIAL_LIVE',
  'IMPERIAL_WALLET',
  'IMPERIAL_JWT',
  'IMPERIAL_API_KEY',
  'IMPERIAL_PROFILE_INDEX',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('EnvironmentVerifier safety gates', () => {
  test('defaults to PAPER mode when no trading env vars are set', async () => {
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const gate = results.find((r) => r.name === 'Safety gates');
    assert.ok(gate);
    assert.equal(gate?.ok, true);
    assert.match(gate?.message ?? '', /PAPER mode/i);
  });

  test('fails when LIVE_TRADING=true but OPERATOR_CONFIRMED is not set', async () => {
    process.env.LIVE_TRADING = 'true';
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const gate = results.find((r) => r.name === 'Safety gates');
    assert.equal(gate?.ok, false);
    assert.match(gate?.message ?? '', /OPERATOR_CONFIRMED=false/);
  });

  test('fails when LIVE_TRADING and OPERATOR_CONFIRMED are true but PERPS_SIM_ONLY is not false', async () => {
    process.env.LIVE_TRADING = 'true';
    process.env.OPERATOR_CONFIRMED = 'true';
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const gate = results.find((r) => r.name === 'Safety gates');
    assert.equal(gate?.ok, false);
    assert.match(gate?.message ?? '', /PERPS_SIM_ONLY is not false/);
  });

  test('reports LIVE mode armed only when simulation is disabled', async () => {
    process.env.LIVE_TRADING = 'true';
    process.env.OPERATOR_CONFIRMED = 'true';
    process.env.PERPS_SIM_ONLY = 'false';
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const gate = results.find((r) => r.name === 'Safety gates');
    assert.equal(gate?.ok, true);
    assert.match(gate?.message ?? '', /LIVE mode/i);
  });

  test('Node.js version check passes on the runtime executing the tests', async () => {
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const node = results.find((r) => r.name === 'Node.js version');
    assert.equal(node?.ok, true);
  });

  test('Helius RPC check fails when no RPC env var is set', async () => {
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const rpc = results.find((r) => r.name === 'Helius RPC endpoint');
    assert.equal(rpc?.ok, false);
  });

  test('Helius RPC check passes when the URL contains "helius"', async () => {
    process.env.HELIUS_RPC_URL = 'https://rpc.helius.dev/v1?api-key=x';
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const rpc = results.find((r) => r.name === 'Helius RPC endpoint');
    assert.equal(rpc?.ok, true);
  });
});

describe('EnvironmentVerifier Imperial config', () => {
  test('reports Imperial as optional when not configured', async () => {
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const imperial = results.find((r) => r.name === 'Imperial router');
    assert.equal(imperial?.ok, true);
    assert.match(imperial?.message ?? '', /disabled/);
  });

  test('fails when Imperial live is requested without a JWT and wallet', async () => {
    process.env.LIVE_TRADING = 'true';
    process.env.OPERATOR_CONFIRMED = 'true';
    process.env.PERPS_SIM_ONLY = 'false';
    process.env.IMPERIAL_LIVE = 'true';
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const imperial = results.find((r) => r.name === 'Imperial router');
    assert.equal(imperial?.ok, false);
    assert.match(imperial?.message ?? '', /IMPERIAL_WALLET/);
  });

  test('passes Imperial live readiness when all required live credentials are set', async () => {
    process.env.LIVE_TRADING = 'true';
    process.env.OPERATOR_CONFIRMED = 'true';
    process.env.PERPS_SIM_ONLY = 'false';
    process.env.IMPERIAL_LIVE = 'true';
    process.env.IMPERIAL_WALLET = '11111111111111111111111111111111';
    process.env.IMPERIAL_JWT = 'jwt-test-value';
    process.env.IMPERIAL_PROFILE_INDEX = '0';
    const verifier = new EnvironmentVerifier();
    const results = await verifier.verifyAll();
    const imperial = results.find((r) => r.name === 'Imperial router');
    assert.equal(imperial?.ok, true);
    assert.match(imperial?.message ?? '', /live ready/);
  });
});

describe('EnvironmentVerifier.printReport', () => {
  test('ok is true and failed is empty when every result passed', () => {
    const verifier = new EnvironmentVerifier();
    const { ok, failed } = verifier.printReport([{ name: 'a', ok: true, message: 'fine' }]);
    assert.equal(ok, true);
    assert.deepEqual(failed, []);
  });

  test('ok is false and failed lists only the failing results', () => {
    const verifier = new EnvironmentVerifier();
    const results = [
      { name: 'a', ok: true, message: 'fine' },
      { name: 'b', ok: false, message: 'broken', remedy: 'fix it' },
    ];
    const { ok, failed } = verifier.printReport(results);
    assert.equal(ok, false);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].name, 'b');
  });
});
