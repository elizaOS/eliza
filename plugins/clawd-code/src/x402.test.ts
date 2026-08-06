import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { X402Client } from './x402.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'clawd-x402-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function configAt(content: string): string {
  const path = join(tmpDir, '.env');
  writeFileSync(path, content);
  return path;
}

describe('X402Client.buildRequest', () => {
  test('defaults to the public gateway when no config file exists', () => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    const { url, init } = client.buildRequest('/api/ping');
    assert.equal(url, 'https://x402.wtf/api/ping');
    assert.equal(init.method, 'GET');
  });

  test('reads X402_GATEWAY_URL and X402_PAYMENT_SECRET from config', () => {
    const path = configAt('X402_GATEWAY_URL=https://custom.gateway\nX402_PAYMENT_SECRET=shh\n');
    const client = new X402Client(path);
    const { url, init } = client.buildRequest('/api/ping');
    assert.equal(url, 'https://custom.gateway/api/ping');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer shh');
  });

  test('passes through an absolute URL unchanged instead of prefixing the gateway', () => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    const { url } = client.buildRequest('https://other-host.example/api/x');
    assert.equal(url, 'https://other-host.example/api/x');
  });

  test('sets X-402-Amount and X-402-Destination headers', () => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    const { init } = client.buildRequest('/pay', { amount: 5, destination: 'WALLET123' });
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['X-402-Amount'], '5');
    assert.equal(headers['X-402-Destination'], 'WALLET123');
  });

  test('omits X-402-Destination when none is provided', () => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    const { init } = client.buildRequest('/pay');
    const headers = init.headers as Record<string, string>;
    assert.equal('X-402-Destination' in headers, false);
  });

  test('omits Authorization header when no payment secret is configured', () => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    const { init } = client.buildRequest('/api/ping');
    const headers = init.headers as Record<string, string>;
    assert.equal('Authorization' in headers, false);
  });

  test('serializes a body to JSON', () => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    const { init } = client.buildRequest('/pay', { method: 'POST', body: { service: 'x', amount: 1 } });
    assert.equal(init.body, JSON.stringify({ service: 'x', amount: 1 }));
  });
});

describe('X402Client.request (mocked fetch)', () => {
  test('parses a JSON response body', async (t) => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await client.request<{ ok: boolean }>('/api/ping');
    assert.deepEqual(result, { ok: true });
  });

  test('falls back to raw text when the response is not JSON', async (t) => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    t.mock.method(globalThis, 'fetch', async () => new Response('pong', { status: 200 }));

    const result = await client.request<string>('/api/ping');
    assert.equal(result, 'pong');
  });

  test('throws with status code and body snippet on a non-2xx response', async (t) => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    t.mock.method(globalThis, 'fetch', async () => new Response('not found', { status: 404 }));

    await assert.rejects(() => client.request('/api/missing'), /404/);
  });

  test('checkBalance returns false (not throws) when the request fails', async (t) => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    t.mock.method(globalThis, 'fetch', async () => new Response('error', { status: 500 }));

    const ok = await client.checkBalance('WALLET123', 10);
    assert.equal(ok, false);
  });

  test('checkBalance returns true when balance meets the required amount', async (t) => {
    const client = new X402Client(join(tmpDir, 'nope.env'));
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ balance: 25 }), { status: 200 }));

    const ok = await client.checkBalance('WALLET123', 10);
    assert.equal(ok, true);
  });
});
