import type { Metadata } from './primitives';
import { Service } from './service';
import type { TokenBalance } from './token';

/**
 * A standardized representation of a liquidity pool from any DEX.
 */
export type PoolInfo = {
  id: string; // Unique identifier for the pool (e.g., LP token mint or a DEX-specific ID).
  displayName?: string; // User-friendly name for the pool.
  dex: string; // Identifier for the DEX (e.g., "orca", "raydium").
  tokenA: {
    mint: string;
    symbol?: string;
    reserve?: string;
    decimals?: number;
  };
  tokenB: {
    mint: string;
    symbol?: string;
    reserve?: string;
    decimals?: number;
  };
  lpTokenMint?: string;
  apr?: number; // Annual Percentage Rate.
  apy?: number; // Annual Percentage Yield.
  tvl?: number; // Total Value Locked in USD.
  fee?: number; // Trading fee percentage.
  metadata?: Metadata; // For DEX-specific extra data.
};

/**
 * A standardized representation of a user's position in a liquidity pool.
 */
export type LpPositionDetails = {
  poolId: string;
  dex: string;
  lpTokenBalance: TokenBalance;
  underlyingTokens: TokenBalance[]; // Array of two token balances.
  valueUsd?: number;
  accruedFees?: TokenBalance[];
  rewards?: TokenBalance[];
  metadata?: Metadata; // For additional DEX-specific position data.
};

/**
 * A standardized result for blockchain transactions.
 */
export type TransactionResult = {
  success: boolean;
  transactionId?: string;
  error?: string;
  data?: any;
};

/**
 * Abstract interface for a Liquidity Pool Service.
 * DEX-specific plugins (e.g., for Orca, Raydium) must implement this service
 * to allow the LP Manager to interact with them in a standardized way.
 */
export abstract class ILpService extends Service {
  static override readonly serviceType = 'lp';

  public readonly capabilityDescription = 'Provides standardized access to DEX liquidity pools.';

  /**
   * Returns the name of the DEX this service interacts with.
   * @returns The name of the DEX (e.g., "Orca", "Raydium").
   */
  abstract getDexName(): string;

  /**
   * Fetches a list of available liquidity pools from the DEX.
   * @param tokenAMint - Optional: Filter pools by the mint address of the first token.
   * @param tokenBMint - Optional: Filter pools by the mint address of the second token.
   * @returns A promise that resolves to an array of standardized PoolInfo objects.
   */
  abstract getPools(tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]>;

  /**
   * Adds liquidity to a specified pool.
   * @param params - The parameters for adding liquidity.
   * @returns A promise resolving to a transaction result, including the LP tokens received.
   */
  abstract addLiquidity(params: {
    userVault: any;
    poolId: string;
    tokenAAmountLamports: string;
    tokenBAmountLamports?: string;
    slippageBps: number;
    tickLowerIndex?: number; // For concentrated liquidity
    tickUpperIndex?: number; // For concentrated liquidity
  }): Promise<TransactionResult & { lpTokensReceived?: TokenBalance }>;

  /**
   * Removes liquidity from a specified pool.
   * @param params - The parameters for removing liquidity.
   * @returns A promise resolving to a transaction result, including the tokens received.
   */
  abstract removeLiquidity(params: {
    userVault: any;
    poolId: string;
    lpTokenAmountLamports: string;
    slippageBps: number;
  }): Promise<TransactionResult & { tokensReceived?: TokenBalance[] }>;

  /**
   * Fetches the details of a specific LP position for a user.
   * @param userAccountPublicKey - The user's wallet public key.
   * @param poolOrPositionIdentifier - The identifier for the pool or a specific position (e.g., position NFT mint).
   * @returns A promise resolving to the position details or null if not found.
   */
  abstract getLpPositionDetails(
    userAccountPublicKey: string,
    poolOrPositionIdentifier: string
  ): Promise<LpPositionDetails | null>;

  /**
   * Fetches the latest market data (e.g., APY, TVL) for a list of pools.
   * @param poolIds - An array of pool IDs to fetch data for.
   * @returns A promise resolving to a map of pool IDs to their partial market data.
   */
  abstract getMarketDataForPools(poolIds: string[]): Promise<Record<string, Partial<PoolInfo>>>;
}
