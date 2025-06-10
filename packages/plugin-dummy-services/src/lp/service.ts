import {
  IAgentRuntime,
  ILpService,
  LpPositionDetails,
  PoolInfo,
  TokenBalance,
  TransactionResult,
  Service,
} from '@elizaos/core';

export class DummyLpService extends ILpService {
  public getDexName(): string {
    return 'dummy';
  }

  static async start(runtime: IAgentRuntime): Promise<DummyLpService> {
    const service = new DummyLpService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService<DummyLpService>(DummyLpService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async start(runtime: IAgentRuntime): Promise<void> {
    console.log('[DummyLpService] started.');
  }

  async stop(): Promise<void> {
    console.log('[DummyLpService] stopped.');
  }

  public async getPools(tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]> {
    console.log(`[DummyLpService] getPools called with: ${tokenAMint}, ${tokenBMint}`);

    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a';

    const pools = [
      {
        id: 'dummy-pool-1',
        dex: 'dummy',
        tokenA: { mint: SOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9 },
        tokenB: { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        apr: 0.12,
        apy: 0.125,
        tvl: 1234567.89,
        fee: 0.0025,
        metadata: { name: 'SOL/USDC Dummy Pool', isStable: false },
      },
      {
        id: 'dummy-stable-pool-2',
        dex: 'dummy',
        tokenA: { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
        tokenB: {
          mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          symbol: 'USDT',
          name: 'Tether',
          decimals: 6,
        },
        apr: 0.08,
        apy: 0.082,
        tvl: 2500000.0,
        fee: 0.0005,
        metadata: { name: 'USDC/USDT Dummy Stable Pool', isStable: true },
      },
    ];

    return pools.filter((p) => {
      if (!tokenAMint && !tokenBMint) return true;
      const hasTokenA = p.tokenA.mint === tokenAMint || p.tokenB.mint === tokenAMint;
      const hasTokenB = p.tokenA.mint === tokenBMint || p.tokenB.mint === tokenBMint;
      if (tokenAMint && tokenBMint) return hasTokenA && hasTokenB;
      if (tokenAMint) return hasTokenA;
      if (tokenBMint) return hasTokenB;
      return false;
    });
  }

  public async addLiquidity(params: {
    userVault: any;
    poolId: string;
    tokenAAmountLamports: string;
    tokenBAmountLamports?: string;
    slippageBps: number;
  }): Promise<TransactionResult & { lpTokensReceived?: TokenBalance }> {
    console.log(`[DummyLpService] addLiquidity called for pool: ${params.poolId}`);
    return {
      success: true,
      transactionId: `dummy-tx-${Date.now()}`,
      lpTokensReceived: {
        address: `dummy-lp-mint-${params.poolId}`,
        balance: '100000000', // 100 LP tokens
        symbol: 'DUMMY-LP',
        uiAmount: 100,
        decimals: 6,
        name: `Dummy LP Token for ${params.poolId}`,
      },
    };
  }

  public async removeLiquidity(params: {
    userVault: any;
    poolId: string;
    lpTokenAmountLamports: string;
    slippageBps: number;
  }): Promise<TransactionResult & { tokensReceived?: TokenBalance[] }> {
    console.log(`[DummyLpService] removeLiquidity called for pool: ${params.poolId}`);
    return {
      success: true,
      transactionId: `dummy-tx-${Date.now()}`,
      tokensReceived: [
        {
          address: 'So11111111111111111111111111111111111111112',
          balance: '500000000',
          symbol: 'SOL',
          uiAmount: 0.5,
          decimals: 9,
          name: 'Solana',
        },
        {
          address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a',
          balance: '500000000',
          symbol: 'USDC',
          uiAmount: 500,
          decimals: 6,
          name: 'USD Coin',
        },
      ],
    };
  }

  public async getLpPositionDetails(
    userAccountPublicKey: string,
    poolOrPositionIdentifier: string
  ): Promise<LpPositionDetails | null> {
    console.log(
      `[DummyLpService] getLpPositionDetails called for user: ${userAccountPublicKey}, identifier: ${poolOrPositionIdentifier}`
    );
    // This is a mock. In a real scenario, you'd look up position details based on the identifier.
    // The identifier could be the pool ID for a simple AMM or a position NFT mint for a CLMM.
    return {
      poolId: 'dummy-pool-1', // Assuming the identifier maps back to a known pool
      dex: 'dummy',
      lpTokenBalance: {
        address: poolOrPositionIdentifier,
        balance: '100000000',
        symbol: 'DUMMY-LP',
        uiAmount: 100,
        decimals: 6,
        name: `Dummy LP Token`,
      },
      underlyingTokens: [
        {
          address: 'So11111111111111111111111111111111111111112',
          balance: '500000000',
          symbol: 'SOL',
          uiAmount: 0.5,
          decimals: 9,
          name: 'Solana',
        },
        {
          address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyB7u6a',
          balance: '500000000',
          symbol: 'USDC',
          uiAmount: 500,
          decimals: 6,
          name: 'USD Coin',
        },
      ],
      valueUsd: 1000,
      metadata: { apr: 0.12 },
    };
  }

  public async getMarketDataForPools(
    poolIds: string[]
  ): Promise<Record<string, Partial<PoolInfo>>> {
    console.log(`[DummyLpService] getMarketDataForPools called for pools: ${poolIds.join(', ')}`);
    const results: Record<string, Partial<PoolInfo>> = {};
    for (const poolId of poolIds) {
      results[poolId] = {
        apy: Math.random() * 0.2,
        tvl: Math.random() * 1000000,
        apr: Math.random() * 0.18,
      };
    }
    return results;
  }
}
