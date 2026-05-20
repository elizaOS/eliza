import { describe, expect, test } from 'bun:test';
import { CHAIN_ID } from '@babylon/shared';

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('getNftChainId', () => {
  test('uses CHAIN_ID when NFT_CHAIN_ID is unset', async () => {
    const value = await withEnv({ NFT_CHAIN_ID: undefined }, async () => {
      const mod = await import(`../nft-chain.ts?t=${Date.now()}`);
      return mod.getNftChainId();
    });

    expect(value).toBe(CHAIN_ID);
  });

  test('throws if legacy NFT_CHAIN_ID mismatches configured CHAIN_ID', async () => {
    const mismatched = CHAIN_ID === 1 ? 11155111 : 1;
    await expect(
      withEnv({ NFT_CHAIN_ID: String(mismatched) }, async () => {
        const mod = await import(`../nft-chain.ts?t=${Date.now()}`);
        return mod.getNftChainId();
      })
    ).rejects.toThrow('NFT_CHAIN_ID must match');
  });
});
