import { IAgentRuntime, Service, logger } from '@elizaos/core';

// Define LP-specific types locally since they're not in core
export interface LpPositionDetails {
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  liquidity: bigint;
  range?: {
    lower: number;
    upper: number;
  };
}

export interface PoolInfo {
  address: string;
  tokenA: string;
  tokenB: string;
  fee: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
}

export interface TokenBalance {
  token: string;
  balance: bigint;
  decimals: number;
}

export interface TransactionResult {
  hash: string;
  success: boolean;
  error?: string;
}

/**
 * Dummy LP service for testing purposes
 * Provides mock implementations of liquidity pool operations
 */
export class DummyLpService extends Service {
  // Use a custom service type since LP isn't in ServiceType enum
  static readonly serviceType = 'lp';

  capabilityDescription = 'Dummy LP service for testing';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  public getDexName(): string {
    return 'dummy';
  }

  static async start(runtime: IAgentRuntime): Promise<DummyLpService> {
    const service = new DummyLpService(runtime);
    await service.start();
    return service;
  }

  async start(): Promise<void> {
    console.log('[DummyLpService] started.');
  }

  async stop(): Promise<void> {
    console.log('[DummyLpService] stopped.');
  }

  async getPoolInfo(poolAddress: string): Promise<PoolInfo> {
    return {
      address: poolAddress,
      tokenA: '0xTokenA',
      tokenB: '0xTokenB',
      fee: 3000,
      liquidity: BigInt(1000000),
      sqrtPriceX96: BigInt(1000000),
      tick: 0,
    };
  }

  async getPosition(positionId: string): Promise<LpPositionDetails | null> {
    return {
      poolAddress: '0xPool',
      tokenA: '0xTokenA',
      tokenB: '0xTokenB',
      liquidity: BigInt(1000),
    };
  }

  async addLiquidity(params: {
    poolAddress: string;
    tokenAMint: string;
    tokenBMint: string;
    tokenAAmountLamports: string;
    slippageBps: number;
  }): Promise<{
    success: boolean;
    transactionId?: string;
    lpTokensReceived?: any;
    error?: string;
  }> {
    return {
      success: true,
      transactionId: `dummy-tx-${Date.now()}`,
      lpTokensReceived: {
        amount: '100000000', // 100 LP tokens
        address: 'dummy-lp-mint-dummy-pool-1',
        uiAmount: 100,
      },
    };
  }

  async removeLiquidity(params: {
    poolAddress: string;
    lpTokenMint: string;
    lpTokenAmountLamports: string;
    slippageBps: number;
  }): Promise<{
    success: boolean;
    transactionId?: string;
    tokensReceived?: any[];
    error?: string;
  }> {
    return {
      success: true,
      transactionId: `dummy-tx-${Date.now()}`,
      tokensReceived: [
        { token: 'tokenA', amount: '1000000000', symbol: 'SOL' }, // 1 token A
        { token: 'tokenB', amount: '1000000', symbol: 'USDC' }, // 1 token B (different decimals)
      ],
    };
  }

  async collectFees(positionId: string): Promise<TransactionResult> {
    return {
      hash: '0xDummyHash',
      success: true,
    };
  }

  async getBalances(address: string): Promise<TokenBalance[]> {
    return [
      {
        token: '0xTokenA',
        balance: BigInt(1000),
        decimals: 18,
      },
      {
        token: '0xTokenB',
        balance: BigInt(2000),
        decimals: 18,
      },
    ];
  }

  async getPools(tokenAMint?: string): Promise<any[]> {
    const pools = [
      {
        id: 'dummy-pool-1',
        tokenA: { mint: 'So11111111111111111111111111111111111111112' },
        tokenB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        liquidity: '1000000',
        type: 'concentrated',
      },
      {
        id: 'dummy-stable-pool-2',
        tokenA: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        tokenB: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
        liquidity: '5000000',
        type: 'stable',
      },
    ];

    if (tokenAMint) {
      return pools.filter((pool) => pool.tokenA.mint === tokenAMint);
    }
    return pools;
  }

  async getLpPositionDetails(userPublicKey: string, positionId: string): Promise<any> {
    // positionId format: 'dummy-lp-mint-dummy-pool-1'
    const parts = positionId.split('-');
    // Find the index of 'dummy' that starts the pool ID
    const poolStartIndex = parts.lastIndexOf('dummy');
    const poolId = parts.slice(poolStartIndex).join('-'); // Extract 'dummy-pool-1'
    const lpMint = parts.slice(0, poolStartIndex).join('-'); // Extract 'dummy-lp-mint'

    return {
      dex: 'dummy',
      poolId,
      userPublicKey,
      lpTokenBalance: {
        amount: 100,
        address: positionId,
      },
      lpMint,
      positionValue: 1000,
      valueUsd: 1000,
      tokenAAmount: 500,
      tokenBAmount: 500,
      sharePercentage: 0.01,
      apr: 15.5,
      fees24h: 2.5,
      unclaimedFees: 5.75,
      underlyingTokens: [
        { symbol: 'tokenA', amount: 500 },
        { symbol: 'tokenB', amount: 500 },
      ],
      raw: {
        lpTokenDecimals: 9,
        tokenADecimals: 9,
        tokenBDecimals: 6,
      },
    };
  }

  async getMarketDataForPools(poolIds: string[]): Promise<any> {
    const marketData: any = {};

    for (const poolId of poolIds) {
      marketData[poolId] = {
        poolId,
        price: 1.0 + Math.random() * 0.1,
        volume24h: 100000 + Math.random() * 50000,
        tvl: 1000000 + Math.random() * 500000,
        apy: 10 + Math.random() * 20,
        priceChange24h: -5 + Math.random() * 10,
      };
    }

    return marketData;
  }

  async swap(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    minAmountOut: bigint,
    slippage?: number
  ): Promise<TransactionResult> {
    return {
      hash: '0xDummyHash',
      success: true,
    };
  }
}
