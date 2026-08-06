import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canMutateSolana,
  formatSol,
  inferSolanaCluster,
  isMutationRpcMethod,
  isSolanaAddress,
  resolveSolanaHarnessConfig,
  SolanaHarnessRpcClient,
} from './solana-harness.js';

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('solana harness config', () => {
  test('infers clusters from common rpc urls', () => {
    assert.equal(inferSolanaCluster('https://api.mainnet-beta.solana.com'), 'mainnet-beta');
    assert.equal(inferSolanaCluster('https://api.devnet.solana.com'), 'devnet');
    assert.equal(inferSolanaCluster('http://127.0.0.1:8899'), 'localnet');
    assert.equal(inferSolanaCluster('https://example.invalid/rpc'), 'custom');
  });

  test('resolves defaults and helius fallback', () => {
    const config = resolveSolanaHarnessConfig({ HELIUS_API_KEY: 'h-key' });

    assert.equal(config.rpcUrl, 'https://mainnet.helius-rpc.com/?api-key=h-key');
    assert.equal(config.cluster, 'mainnet-beta');
    assert.equal(config.commitment, 'confirmed');
    assert.equal(config.readOnly, true);
  });

  test('mutation gate requires all live flags', () => {
    const base = resolveSolanaHarnessConfig({ SOLANA_RPC_URL: 'http://127.0.0.1:8899' });

    assert.equal(canMutateSolana(base), false);
    assert.equal(canMutateSolana({ ...base, readOnly: false, liveTrading: true, operatorConfirmed: true }), true);
  });
});

describe('solana harness utilities', () => {
  test('validates likely Solana addresses', () => {
    assert.equal(isSolanaAddress('11111111111111111111111111111111'), true);
    assert.equal(isSolanaAddress('not an address'), false);
  });

  test('formats lamports as SOL', () => {
    assert.equal(formatSol(1_500_000_000), '1.5 SOL');
  });

  test('marks sendTransaction as mutation RPC', () => {
    assert.equal(isMutationRpcMethod('sendTransaction'), true);
    assert.equal(isMutationRpcMethod('getBalance'), false);
  });
});

describe('SolanaHarnessRpcClient', () => {
  test('posts JSON-RPC requests', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const client = new SolanaHarnessRpcClient(
      resolveSolanaHarnessConfig({ SOLANA_RPC_URL: 'http://127.0.0.1:8899' }),
      async (input, init) => {
        calls.push({ input, init });
        return response({ jsonrpc: '2.0', id: 1, result: { value: 42 } });
      },
    );

    const result = await client.getBalance('11111111111111111111111111111111');

    assert.deepEqual(result, { value: 42 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, 'http://127.0.0.1:8899');
    assert.match(String(calls[0].init?.body), /"method":"getBalance"/);
  });

  test('blocks raw sendTransaction when mutation gate is closed', async () => {
    const client = new SolanaHarnessRpcClient(resolveSolanaHarnessConfig({ SOLANA_RPC_URL: 'http://127.0.0.1:8899' }));

    await assert.rejects(() => client.sendRawTransaction('abc'), /blocked/i);
  });
});
