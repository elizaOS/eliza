/**
 * Feed Engine - Client-Safe Exports
 *
 * This module exports utilities that are safe to use in client-side code.
 * It does NOT include any server-only dependencies like Redis, Postgres,
 * or Node.js built-in modules (tls, fs, child_process, etc.)
 *
 * Use this import for React client components:
 * import { PredictionPricing } from '@feed/engine/client';
 */

// Prediction Pricing (pure math, no server dependencies)
// IMPORTANT: Use /client path to avoid pulling in PredictionDbAdapter which imports @feed/db
export {
  calculateExpectedPayout,
  PredictionPricing,
  type ShareCalculation,
  type ShareCalculationWithFees,
} from "@feed/core/markets/prediction/pricing";
// Fee Configuration (pure constants, no dependencies)
export {
  FEE_CONFIG,
  type FeeTransactionType,
  type FeeType,
} from "./config/fees";
export {
  calculatePerpPositionMarketValue,
  toNumber,
} from "./portfolio-valuation";
// Concentrated Liquidity (pure math)
export {
  type AddPositionParams,
  ConcentratedLiquidityPool,
  type ConcentratedPosition,
  type ConcentratedTradeResult,
  calculateOptimalRange,
  createPoolFromMarket,
  estimateFeeAPR,
  type PoolConfig,
  type PoolState,
  type RemovePositionResult,
} from "./prediction-concentrated-liquidity";
// Reputation calculations that are pure functions (no DB)
// Import directly from the pnl-normalizer file to avoid pulling in server-side deps from the barrel export
export {
  calculateAverageROI,
  calculateConfidenceScore,
  calculateSharpeRatio,
  calculateWinRate,
  denormalizePnL,
  getTrustLevel,
  normalizePnL,
} from "./reputation/pnl-normalizer";
// Common Types (types only)
export type {
  ApiResponse,
  ErrorLike,
  FilterParams,
  JsonRpcParams,
  JsonRpcResult,
  JsonValue,
  LLMResponse,
  LogData,
  PaginatedResponse,
  PaginationParams,
  QueryParams,
  SortOrder,
  SortParams,
  StringRecord,
  WebSocketData,
} from "./types/common";
// Market Decision Types (types only, no runtime code)
export type {
  ExecutedTrade,
  MarketAction,
  MarketType,
  TradeImpact,
  TradingDecision,
  TradingExecutionResult,
} from "./types/market-decisions";
// Shared Game Types (re-exported from types, no server deps)
export type {
  Actor,
  ActorConnection,
  ActorData,
  ActorRelationship,
  ActorState,
  ActorsDatabase,
  ActorTier,
  DayTimeline,
  FeedEvent,
  FeedPost,
  GameHistory,
  GameResolution,
  GameSetup,
  GameState,
  GeneratedGame,
  GenesisGame,
  GroupChat,
  GroupChatMessage,
  LuckChange,
  MoodChange,
  Organization,
  OrgType,
  PostType,
  PriceUpdate,
  Question,
  QuestionOutcome,
  RelationshipType,
  Scenario,
  SelectedActor,
  StockPrice,
  WorldEvent,
} from "./types/shared";
export {
  ACTOR_TIERS,
  DAY_RANGES,
  getEscalationLevel,
  ORG_TYPES,
  POST_TYPES,
  RELATIONSHIP_TYPES,
} from "./types/shared";
// Utils - Randomization (pure functions)
export {
  pickRandom,
  randomChance,
  randomInt,
  sampleRandom,
  shuffleArray,
} from "./utils/randomization";

// Portfolio PnL type (interface only, no runtime deps - defined here to avoid importing from server-only file)
export interface PortfolioPnLSnapshot {
  lifetimePnL: number;
  netContributions: number;
  netPeerTransfers: number;
  totalDeposited: number;
  totalWithdrawn: number;
  availableBalance: number;
  unrealizedPerpPnL: number;
  unrealizedPredictionPnL: number;
  totalUnrealizedPnL: number;
  totalPnL: number;
  accountEquity: number;
}

export interface PortfolioBreakdownSnapshot {
  wallet: number;
  agents: number;
  positions: number;
  available: number;
  netPeerTransfers: number;
  originalAmount: number;
  totalAssets: number;
  totalPnL: number;
  agentCount: number;
  members?: PortfolioBreakdownMember[];
}

export interface PortfolioBreakdownMember {
  id: string;
  name: string;
  wallet: number;
  isAgent: boolean;
}
