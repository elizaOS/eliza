import { IAgentRuntime } from '@elizaos/core';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, beforeEach } from 'bun:test';
import { DummyLpService } from '../service';

describe('DummyLpService', () => {
  let service: DummyLpService;
  const mockRuntime = {} as IAgentRuntime;

  beforeEach(() => {
    service = new DummyLpService();
    service.start(mockRuntime);
  });

  it('should have the correct DEX name', () => {
    expect(service.getDexName()).toBe('dummy');
  });

  describe('getPools', () => {
    it('should return all dummy pools when no mints are specified', async () => {
      const pools = await service.getPools();
      expect(pools.length).toBe(2);
      expect(pools[0].id).toBe('dummy-pool-1');
      expect(pools[1].id).toBe('dummy-stable-pool-2');
    });

    it('should filter pools by tokenA mint', async () => {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const pools = await service.getPools(SOL_MINT);
      expect(pools.length).toBe(1);
      expect(pools[0].id).toBe('dummy-pool-1');
    });

    it('should return an empty array if no pools match the filter', async () => {
      const pools = await service.getPools('non-existent-mint');
      expect(pools.length).toBe(0);
    });
  });

  describe('addLiquidity', () => {
    it('should return a successful transaction result with LP tokens', async () => {
      const result = await service.addLiquidity({
        userVault: Keypair.generate(),
        poolId: 'dummy-pool-1',
        tokenAAmountLamports: '1000000000', // 1 SOL
        slippageBps: 50,
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toMatch(/^dummy-tx-\d+$/);
      expect(result.lpTokensReceived).toBeDefined();
      expect(result.lpTokensReceived?.address).toBe('dummy-lp-mint-dummy-pool-1');
      expect(result.lpTokensReceived?.uiAmount).toBe(100);
    });
  });

  describe('removeLiquidity', () => {
    it('should return a successful transaction result with underlying tokens', async () => {
      const result = await service.removeLiquidity({
        userVault: Keypair.generate(),
        poolId: 'dummy-pool-1',
        lpTokenAmountLamports: '100000000', // 100 LP tokens
        slippageBps: 50,
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toMatch(/^dummy-tx-\d+$/);
      expect(result.tokensReceived).toBeDefined();
      expect(result.tokensReceived?.length).toBe(2);
      expect(result.tokensReceived?.[0].symbol).toBe('SOL');
      expect(result.tokensReceived?.[1].symbol).toBe('USDC');
    });
  });

  describe('getLpPositionDetails', () => {
    it('should return mock LP position details', async () => {
      const userPublicKey = Keypair.generate().publicKey.toBase58();
      const positionId = 'dummy-lp-mint-dummy-pool-1';
      const details = await service.getLpPositionDetails(userPublicKey, positionId);

      expect(details).toBeDefined();
      expect(details?.dex).toBe('dummy');
      expect(details?.poolId).toBe('dummy-pool-1');
      expect(details?.valueUsd).toBe(1000);
      expect(details?.underlyingTokens.length).toBe(2);
      expect(details?.lpTokenBalance.address).toBe(positionId);
    });
  });

  describe('getMarketDataForPools', () => {
    it('should return random market data for given pool IDs', async () => {
      const poolIds = ['dummy-pool-1', 'dummy-stable-pool-2'];
      const marketData = await service.getMarketDataForPools(poolIds);

      expect(Object.keys(marketData).length).toBe(2);
      expect(marketData['dummy-pool-1']).toBeDefined();
      expect(marketData['dummy-pool-1'].apy).toBeTypeOf('number');
      expect(marketData['dummy-pool-1'].tvl).toBeTypeOf('number');
      expect(marketData['dummy-stable-pool-2']).toBeDefined();
    });
  });
});
