import { type IAgentRuntime, Service } from "@elizaos/core";
import type {
  AddLiquidityConfig,
  ILpService,
  LpPositionDetails,
  PoolInfo,
  RemoveLiquidityConfig,
  TransactionResult,
} from "../../types.ts";
import {
  createSolanaLpProtocolProvider,
  getLpManagementService,
} from "../LpManagementService.ts";

export class MockLpService extends Service implements ILpService {
  public readonly capabilityDescription =
    "Provides standardized access to DEX liquidity pools.";
  private positions = new Map<string, LpPositionDetails[]>();

  constructor(
    runtime: IAgentRuntime,
    private readonly dexName = "mock-dex",
  ) {
    super(runtime);
  }

  getDexName(): string {
    return this.dexName;
  }

  async getPools(
    tokenAMint?: string,
    tokenBMint?: string,
  ): Promise<PoolInfo[]> {
    const pools: PoolInfo[] = [
      {
        id: `${this.dexName}-sol-usdc`,
        displayName: `${this.dexName} SOL/USDC`,
        dex: this.dexName,
        tokenA: {
          mint: "So11111111111111111111111111111111111111112",
          symbol: "SOL",
          decimals: 9,
        },
        tokenB: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          symbol: "USDC",
          decimals: 6,
        },
        apr: 12,
        tvl: 1000000,
      },
    ];

    if (!tokenAMint && !tokenBMint) return pools;
    return pools.filter((pool) => {
      const mints = [pool.tokenA?.mint, pool.tokenB?.mint];
      return (
        (!tokenAMint || mints.includes(tokenAMint)) &&
        (!tokenBMint || mints.includes(tokenBMint))
      );
    });
  }

  async addLiquidity(config: AddLiquidityConfig): Promise<TransactionResult> {
    const owner = config.userVault?.publicKey?.toBase58?.() || "test-owner";
    const position: LpPositionDetails = {
      poolId: config.poolId,
      dex: this.dexName,
      lpTokenBalance: {
        address: `lp-${config.poolId}`,
        balance: "1000",
        decimals: 6,
        symbol: "LP",
      },
      underlyingTokens: [],
      accruedFees: [],
      rewards: [],
      valueUsd: 100,
    };
    this.positions.set(owner, [...(this.positions.get(owner) || []), position]);
    return {
      success: true,
      transactionId: `mock-open-${this.dexName}`,
      data: { poolId: config.poolId },
    };
  }

  async removeLiquidity(
    config: RemoveLiquidityConfig,
  ): Promise<TransactionResult> {
    const owner = config.userVault?.publicKey?.toBase58?.() || "test-owner";
    this.positions.set(
      owner,
      (this.positions.get(owner) || []).filter(
        (position) => position.poolId !== config.poolId,
      ),
    );
    return {
      success: true,
      transactionId: `mock-close-${this.dexName}`,
      data: { poolId: config.poolId },
    };
  }

  async getLpPositionDetails(
    owner: string,
    poolOrPositionIdentifier: string,
  ): Promise<LpPositionDetails | null> {
    return (
      (this.positions.get(owner) || []).find(
        (position) => position.poolId === poolOrPositionIdentifier,
      ) || null
    );
  }

  async getMarketDataForPools(
    poolIds: string[],
  ): Promise<Record<string, Partial<PoolInfo>>> {
    return Object.fromEntries(
      poolIds.map((poolId) => [poolId, { apr: 12, tvl: 1000000 }]),
    );
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

export async function registerMockDexServices(
  runtime: IAgentRuntime,
): Promise<void> {
  const registry = await getLpManagementService(runtime);
  if (!registry) return;

  for (const dex of ["raydium", "orca", "meteora"]) {
    const service = new MockLpService(runtime, dex);
    registry.registerProtocol(
      createSolanaLpProtocolProvider({
        dex,
        label: dex,
        service,
      }),
    );
  }
}
