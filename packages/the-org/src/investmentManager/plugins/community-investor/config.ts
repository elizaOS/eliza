/**
 * Configuration for the Community Trader Plugin
 *
 * This file centralizes all configuration options for the trading system.
 */

import type { UUID } from './types';

/**
 * Buy amount configuration
 */
export interface BuyAmountConfig {
  baseAmount: number;
  minAmount: number;
  maxAmount: number;
  trustScoreMultiplier: number;
  convictionMultiplier: number;
}

/**
 * Trading configuration
 */
export interface TradingConfig {
  slippageBps: number;
  forceSimulation: boolean;
  defaultChain: string;
  maxPositionsPerToken: number;
  maxPositionsPerRecommender: number;
  minLiquidityUsd: number;
  maxMarketCapUsd: number;
  buyAmountConfig: BuyAmountConfig;
}

/**
 * Database configuration
 */
export interface DatabaseConfig {
  schemaVersion: string;
  enableCaching: boolean;
  cacheTimeout: number; // in seconds
}

/**
 * Memory configuration
 */
export interface MemoryConfig {
  embeddingModel: string;
  embeddingDimension: number;
  similarityThreshold: number;
  cacheTimeout: number; // in seconds
}

/**
 * Default trading configuration
 */
export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  slippageBps: 100, // 1%
  forceSimulation: false,
  defaultChain: 'solana',
  maxPositionsPerToken: 3,
  maxPositionsPerRecommender: 5,
  minLiquidityUsd: 10000, // $10k
  maxMarketCapUsd: 100000000, // $100M
  buyAmountConfig: {
    baseAmount: 0.1, // 0.1 SOL
    minAmount: 0.01, // 0.01 SOL
    maxAmount: 1.0, // 1 SOL
    trustScoreMultiplier: 0.5,
    convictionMultiplier: 0.3,
  },
};

/**
 * Default database configuration
 */
export const DEFAULT_DATABASE_CONFIG: DatabaseConfig = {
  schemaVersion: '1.0',
  enableCaching: true,
  cacheTimeout: 3600, // 1 hour
};

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  embeddingModel: 'text-embedding-ada-002',
  embeddingDimension: 1536,
  similarityThreshold: 0.7,
  cacheTimeout: 3600, // 1 hour
};

/**
 * Conviction levels for recommendations
 * IMPORTANT: Must match the enum in types.ts
 */
export enum Conviction {
  NONE = 'NONE',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  VERY_HIGH = 'VERY_HIGH',
}

/**
 * Recommendation types
 * IMPORTANT: Must match the enum in types.ts
 */
export enum RecommendationType {
  BUY = 'BUY',
  DONT_BUY = 'DONT_BUY',
  SELL = 'SELL',
  DONT_SELL = 'DONT_SELL',
  NONE = 'NONE',
  HOLD = 'HOLD',
}

/**
 * Transaction types
 * IMPORTANT: Must match the enum in types.ts
 */
export enum TransactionType {
  BUY = 'BUY',
  SELL = 'SELL',
  TRANSFER_IN = 'transfer_in',
  TRANSFER_OUT = 'transfer_out',
}

/**
 * Buy signal message interface
 */
export interface BuySignalMessage {
  tokenAddress: string;
  chain?: string;
  walletAddress?: string;
  isSimulation?: boolean;
  entityId: UUID;
  recommendationId?: UUID;
  conviction?: Conviction;
  price?: string;
  marketCap?: string;
  liquidity?: string;
  type?: RecommendationType;
}

/**
 * Sell signal message interface
 */
export interface SellSignalMessage {
  positionId: UUID;
  tokenAddress: string;
  sellRecommenderId: UUID;
  walletAddress?: string;
  isSimulation?: boolean;
}

/**
 * Utility functions for configuration
 */

/**
 * Get conviction multiplier
 */
export function getConvictionMultiplier(conviction: Conviction): number {
  switch (conviction) {
    case Conviction.NONE:
      return 0;
    case Conviction.LOW:
      return 0.5;
    case Conviction.MEDIUM:
      return 1.0;
    case Conviction.HIGH:
      return 1.5;
    case Conviction.VERY_HIGH:
      return 2.0;
    default:
      return 1.0;
  }
}

/**
 * Get liquidity multiplier
 */
export function getLiquidityMultiplier(liquidity: number): number {
  if (liquidity < 10000) return 0.5;
  if (liquidity < 50000) return 0.75;
  if (liquidity < 100000) return 1.0;
  if (liquidity < 500000) return 1.25;
  return 1.5;
}

/**
 * Get market cap multiplier
 */
export function getMarketCapMultiplier(marketCap: number): number {
  if (marketCap < 100000) return 1.5;
  if (marketCap < 1000000) return 1.25;
  if (marketCap < 10000000) return 1.0;
  if (marketCap < 50000000) return 0.75;
  return 0.5;
}

/**
 * Get volume multiplier
 */
export function getVolumeMultiplier(volume: number): number {
  if (volume < 10000) return 0.5;
  if (volume < 50000) return 0.75;
  if (volume < 100000) return 1.0;
  if (volume < 500000) return 1.25;
  return 1.5;
}
