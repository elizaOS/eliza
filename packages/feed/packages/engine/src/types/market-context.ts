/**
 * Market Context Types
 *
 * Types for providing market information to NPCs for trading decisions
 */

import type { MarketType } from "./market-decisions";

export interface PerpMarketSnapshot {
  ticker: string;
  organizationId: string;
  name: string;
  currentPrice: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  openInterest: number;
}

export interface PredictionMarketSnapshot {
  id: string; // Market ID is a Snowflake string, not an integer
  text: string;
  yesPrice: number;
  noPrice: number;
  totalVolume: number;
  resolutionDate: string;
  daysUntilResolution: number;
  horizonBucket: "short" | "medium" | "long";
  liquidityTier: "thin" | "balanced" | "deep";
  urgencyLevel: "imminent" | "near-term" | "dated";
  eventSensitivity: "low" | "medium" | "high";
  /**
   * Maximum safe single-trade gross amount (inclusive of fees) for this
   * market given current pool depth and the 20ppt odds-move cap. Trades
   * above this limit will be rejected by the slippage guard. Zero means
   * the market is too illiquid to accept any trade.
   */
  maxSafeBet: number;
}

export interface NPCPosition {
  id: string;
  marketType: MarketType;
  ticker?: string;
  marketId?: string; // Market ID is a Snowflake string, not an integer
  side: string;
  entryPrice: number;
  currentPrice: number;
  size: number;
  shares?: number;
  unrealizedPnL: number;
  openedAt: string;
}

export interface FeedPostContext {
  author: string;
  authorName: string;
  content: string;
  timestamp: string;
  articleTitle?: string;
}

export interface GroupChatContext {
  chatId: string;
  chatName: string;
  from: string;
  fromName: string;
  message: string;
  timestamp: string;
}

export interface EventContext {
  type: string;
  description: string;
  timestamp: string;
  relatedQuestion?: number;
  pointsToward?: string;
  actors?: string[];
}

export interface NewsArticleContext {
  author: string;
  authorName: string;
  title: string;
  summary: string;
  timestamp: string;
}

export interface RelationshipContext {
  actorId: string;
  actorName: string;
  relationshipType: string;
  strength: number;
  sentiment: number;
  history?: string;
}

/**
 * Signal analysis summary for a prediction market
 * Provides aggregated signal direction from feed content
 */
export interface MarketSignalContext {
  /** Market/question ID */
  marketId: string;
  /** Aggregated YES evidence weight */
  yesSignal: number;
  /** Aggregated NO evidence weight */
  noSignal: number;
  /** Net signal (yesSignal - noSignal) */
  netSignal: number;
  /** Signal strength (0-1) */
  strength: number;
  /** Suggested outcome based on signal */
  suggestedOutcome: "YES" | "NO" | "UNCERTAIN";
  /** Confidence in suggested outcome (0-1) */
  confidence: number;
}

export interface NPCMarketContext {
  // NPC identity
  npcId: string;
  npcName: string;
  personality: string;
  tier: string;
  availableBalance: number;

  // Information sources
  recentPosts: FeedPostContext[];
  groupChatMessages: GroupChatContext[];
  recentEvents: EventContext[];

  // Relationships with other actors
  relationships?: RelationshipContext[];

  // Market data
  perpMarkets: PerpMarketSnapshot[];
  predictionMarkets: PredictionMarketSnapshot[];

  // Current positions
  currentPositions: NPCPosition[];

  // Signal analysis for prediction markets (internal use only)
  // Helps NPCs make better-informed trading decisions
  marketSignals?: MarketSignalContext[];
}

export interface MarketSnapshots {
  perps: PerpMarketSnapshot[];
  predictions: PredictionMarketSnapshot[];
  timestamp: string;
}
