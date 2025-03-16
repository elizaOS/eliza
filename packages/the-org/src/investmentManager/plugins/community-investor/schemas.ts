import { IAgentRuntime, UUID } from '@elizaos/core';
import { z } from 'zod';
import type { Transaction } from './types.js';

/**
 * Core schema definitions for community-trader plugin
 * This approach provides runtime validation and better type safety
 */

// Define consistent transaction types
export const TransactionType = {
  BUY: 'BUY',
  SELL: 'SELL',
  TRANSFER_IN: 'transfer_in',
  TRANSFER_OUT: 'transfer_out',
} as const;

// Define TokenPerformance schema
export const tokenPerformanceSchema = z.object({
  chain: z.string().default('unknown'),
  address: z.string(),
  name: z.string().optional().default(''),
  symbol: z.string(),
  decimals: z.number().default(0),
  metadata: z.record(z.any()).default({}),
  price: z.number().default(0),
  volume: z.number().default(0),
  trades: z.number().default(0),
  liquidity: z.number().default(0),
  holders: z.number().default(0),
  price24hChange: z.number().default(0),
  volume24hChange: z.number().default(0),
  trades24hChange: z.number().default(0),
  holders24hChange: z.number().default(0),
  initialMarketCap: z.number().default(0),
  currentMarketCap: z.number().default(0),
  rugPull: z.boolean().default(false),
  isScam: z.boolean().default(false),
  sustainedGrowth: z.boolean().default(false),
  rapidDump: z.boolean().default(false),
  suspiciousVolume: z.boolean().default(false),
  validationTrust: z.number().default(0),
  createdAt: z.date().default(() => new Date()),
  updatedAt: z.date().default(() => new Date()),
});

// Define Transaction schema - ensure consistency with types.ts
export const transactionSchema = z.object({
  id: z.string(),
  positionId: z.string(),
  chain: z.string().default('unknown'),
  tokenAddress: z.string(),
  transactionHash: z.string(),
  // Use lowercase transaction types consistently
  type: z.enum([TransactionType.BUY, TransactionType.SELL]),
  // Use number for amounts consistently
  amount: z.number(),
  price: z.number().optional(),
  isSimulation: z.boolean().default(false),
  // Store timestamps as ISO strings consistently
  timestamp: z.string(),
});

// Define RecommenderMetrics schema
export const recommenderMetricsSchema = z.object({
  entityId: z.string(),
  trustScore: z.number(),
  totalRecommendations: z.number(),
  successfulRecs: z.number(),
  avgTokenPerformance: z.number(),
  riskScore: z.number(),
  consistencyScore: z.number(),
  virtualConfidence: z.number(),
  lastActiveDate: z.date(),
  trustDecay: z.number(),
  updatedAt: z
    .date()
    .optional()
    .default(() => new Date()),
});

// Define Position schema
export const positionSchema = z.object({
  id: z.string().uuid(),
  chain: z.string(),
  tokenAddress: z.string(),
  walletAddress: z.string(),
  isSimulation: z.boolean(),
  entityId: z.string(),
  recommendationId: z.string(),
  initialPrice: z.string(),
  initialMarketCap: z.string(),
  initialLiquidity: z.string(),
  performanceScore: z.number(),
  rapidDump: z.boolean(),
  openedAt: z.date(),
  closedAt: z.date().optional(),
  updatedAt: z.date(),
  // Store numeric amounts as strings to avoid precision issues
  amount: z.string(),
  entryPrice: z.string(),
  currentPrice: z.string(),
});

// Define TokenRecommendation schema
export const tokenRecommendationSchema = z.object({
  id: z.string().uuid(),
  entityId: z.string().uuid(),
  chain: z.string(),
  tokenAddress: z.string(),
  type: z.string(),
  conviction: z.string(),
  initialMarketCap: z.string(),
  initialLiquidity: z.string(),
  initialPrice: z.string(),
  marketCap: z.string(),
  liquidity: z.string(),
  price: z.string(),
  rugPull: z.boolean(),
  isScam: z.boolean(),
  riskScore: z.number(),
  performanceScore: z.number(),
  metadata: z.record(z.any()).default({}),
  status: z.enum(['ACTIVE', 'COMPLETED', 'EXPIRED', 'WITHDRAWN']),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Types derived from schemas
export type TokenPerformance = z.infer<typeof tokenPerformanceSchema>;
export type RecommenderMetrics = z.infer<typeof recommenderMetricsSchema>;
export type Position = z.infer<typeof positionSchema>;
export type TokenRecommendation = z.infer<typeof tokenRecommendationSchema>;

/**
 * Transform functions to convert database objects to schema-validated objects
 */

export function transformTokenPerformance(dbToken: any, chain = 'unknown'): TokenPerformance {
  const input = {
    chain,
    address: dbToken.tokenAddress || dbToken.token_address,
    name: dbToken.name || dbToken.symbol,
    symbol: dbToken.symbol,
    price: typeof dbToken.price === 'number' ? dbToken.price : 0,
    volume: typeof dbToken.volume === 'number' ? dbToken.volume : 0,
    trades: typeof dbToken.trades === 'number' ? dbToken.trades : 0,
    liquidity: typeof dbToken.liquidity === 'number' ? dbToken.liquidity : 0,
    holders: typeof dbToken.holders === 'number' ? dbToken.holders : 0,
    price24hChange: typeof dbToken.price_change_24h === 'number' ? dbToken.price_change_24h : 0,
    volume24hChange: typeof dbToken.volume_change_24h === 'number' ? dbToken.volume_change_24h : 0,
    trades24hChange: typeof dbToken.trade_24h_change === 'number' ? dbToken.trade_24h_change : 0,
    holders24hChange: typeof dbToken.holder_change_24h === 'number' ? dbToken.holder_change_24h : 0,
    initialMarketCap:
      typeof dbToken.initial_market_cap === 'number' ? dbToken.initial_market_cap : 0,
    currentMarketCap:
      typeof dbToken.current_market_cap === 'number' ? dbToken.current_market_cap : 0,
    rugPull: Boolean(dbToken.rug_pull),
    isScam: Boolean(dbToken.is_scam),
    sustainedGrowth: Boolean(dbToken.sustained_growth),
    rapidDump: Boolean(dbToken.rapid_dump),
    suspiciousVolume: Boolean(dbToken.suspicious_volume),
    validationTrust: typeof dbToken.validation_trust === 'number' ? dbToken.validation_trust : 0,
    createdAt: dbToken.created_at ? new Date(dbToken.created_at) : new Date(),
    updatedAt: dbToken.updated_at ? new Date(dbToken.updated_at) : new Date(),
  };

  return tokenPerformanceSchema.parse(input);
}

export function transformTransaction(
  dbTx: any,
  positionId = 'unknown',
  chain = 'unknown'
): Transaction {
  const type = typeof dbTx.type === 'string' ? dbTx.type.toLowerCase() : TransactionType.BUY;

  const input = {
    id: dbTx.id || dbTx.transaction_hash || '',
    positionId: dbTx.positionId || dbTx.position_id || positionId,
    chain: dbTx.chain || chain,
    tokenAddress: dbTx.tokenAddress || dbTx.token_address,
    transactionHash: dbTx.transactionHash || dbTx.transaction_hash,
    type: type === 'BUY' || type === 'SELL' ? type : 'BUY',
    amount:
      typeof dbTx.amount === 'bigint'
        ? dbTx.amount
        : typeof dbTx.amount === 'string'
          ? BigInt(dbTx.amount)
          : typeof dbTx.amount === 'number'
            ? BigInt(Math.floor(dbTx.amount))
            : BigInt(0),
    price:
      typeof dbTx.price === 'string'
        ? Number(dbTx.price)
        : typeof dbTx.price === 'number'
          ? dbTx.price
          : undefined,
    isSimulation: Boolean(dbTx.isSimulation || dbTx.is_simulation),
    timestamp:
      dbTx.timestamp instanceof Date
        ? dbTx.timestamp.toISOString()
        : typeof dbTx.timestamp === 'string'
          ? dbTx.timestamp
          : new Date().toISOString(),
  };

  return transactionSchema.parse(input) as unknown as Transaction;
}

export function transformPosition(dbPos: any): Position {
  const input = {
    id: dbPos.id || '',
    chain: dbPos.chain || 'unknown',
    tokenAddress: dbPos.tokenAddress || dbPos.token_address,
    walletAddress: dbPos.walletAddress || dbPos.wallet_address,
    isSimulation: Boolean(dbPos.isSimulation || dbPos.is_simulation),
    entityId: dbPos.entityId || dbPos.recommender_id,
    recommendationId: dbPos.recommendationId || dbPos.recommendation_id,
    initialPrice: dbPos.initialPrice?.toString() || dbPos.initial_price?.toString() || '0',
    initialMarketCap:
      dbPos.initialMarketCap?.toString() || dbPos.initial_market_cap?.toString() || '0',
    initialLiquidity:
      dbPos.initialLiquidity?.toString() || dbPos.initial_liquidity?.toString() || '0',
    performanceScore:
      typeof dbPos.performanceScore === 'number'
        ? dbPos.performanceScore
        : typeof dbPos.performance_score === 'number'
          ? dbPos.performance_score
          : 0,
    rapidDump: Boolean(dbPos.rapidDump || dbPos.rapid_dump),
    openedAt:
      dbPos.openedAt instanceof Date
        ? dbPos.openedAt
        : dbPos.opened_at instanceof Date
          ? dbPos.opened_at
          : typeof dbPos.openedAt === 'string'
            ? new Date(dbPos.openedAt)
            : typeof dbPos.opened_at === 'string'
              ? new Date(dbPos.opened_at)
              : new Date(),
    closedAt:
      dbPos.closedAt instanceof Date
        ? dbPos.closedAt
        : dbPos.closed_at instanceof Date
          ? dbPos.closed_at
          : typeof dbPos.closedAt === 'string'
            ? new Date(dbPos.closedAt)
            : typeof dbPos.closed_at === 'string'
              ? new Date(dbPos.closed_at)
              : undefined,
    updatedAt:
      dbPos.updatedAt instanceof Date
        ? dbPos.updatedAt
        : dbPos.updated_at instanceof Date
          ? dbPos.updated_at
          : typeof dbPos.updatedAt === 'string'
            ? new Date(dbPos.updatedAt)
            : typeof dbPos.updated_at === 'string'
              ? new Date(dbPos.updated_at)
              : new Date(),
    amount: dbPos.amount?.toString() || '0',
    entryPrice: dbPos.entryPrice?.toString() || dbPos.entry_price?.toString() || '0',
    currentPrice: dbPos.currentPrice?.toString() || dbPos.current_price?.toString() || '0',
  };

  return positionSchema.parse(input);
}

export function transformTokenRecommendation(dbRec: any): TokenRecommendation {
  try {
    return tokenRecommendationSchema.parse({
      id: dbRec.id || dbRec.recommendation_id,
      entityId: dbRec.entityId || dbRec.recommender_id,
      chain: dbRec.chain || 'unknown',
      tokenAddress: dbRec.tokenAddress || dbRec.token_address,
      type: dbRec.type || 'BUY',
      conviction: dbRec.conviction || 'MEDIUM',
      initialMarketCap: dbRec.initialMarketCap || dbRec.initial_market_cap || '0',
      initialLiquidity: dbRec.initialLiquidity || dbRec.initial_liquidity || '0',
      initialPrice: dbRec.initialPrice || dbRec.initial_price || '0',
      marketCap: dbRec.marketCap || dbRec.market_cap || '0',
      liquidity: dbRec.liquidity || '0',
      price: dbRec.price || '0',
      rugPull: Boolean(dbRec.rugPull || dbRec.rug_pull || false),
      isScam: Boolean(dbRec.isScam || dbRec.is_scam || false),
      riskScore: dbRec.riskScore || dbRec.risk_score || 0,
      performanceScore: dbRec.performanceScore || dbRec.performance_score || 0,
      metadata: dbRec.metadata || {},
      status: dbRec.status || 'ACTIVE',
      createdAt: new Date(dbRec.createdAt || dbRec.created_at || Date.now()),
      updatedAt: new Date(dbRec.updatedAt || dbRec.updated_at || Date.now()),
    });
  } catch (error) {
    console.error('Error transforming token recommendation:', error);
    return null;
  }
}
