/**
 * Markets Types - Centralized type definitions for markets frontend
 *
 * This module consolidates all market-related types used across the frontend.
 * Import from here instead of defining inline types in components.
 *
 * @example
 * ```tsx
 * import type { PredictionMarket, MarketTab, TradeSide } from '@/types/markets';
 * import { MARKETS_CONFIG } from '@/types/markets';
 * ```
 */

// =============================================================================
// Re-exports from @polyagent/shared
// =============================================================================

// Import types for internal use in this file
import type { UserPredictionPosition as SharedUserPredictionPosition } from "@polyagent/shared";

export type {
  DailyPriceSnapshot,
  FundingRate,
  Liquidation,
  OrderRequest,
  PerpMarket as SharedPerpMarket,
  PerpPosition,
  PositionUpdate,
  PredictionPosition,
  TradingStats,
  UserPredictionPosition,
} from "@polyagent/shared";

// Local alias for internal use
type UserPredictionPosition = SharedUserPredictionPosition;

export {
  calculateFundingPayment,
  calculateLiquidationPrice,
  calculateMarkPrice,
  calculateUnrealizedPnL,
  shouldLiquidate,
} from "@polyagent/shared";

// =============================================================================
// Market Types
// =============================================================================

/**
 * Perp market data structure from API.
 *
 * This is the simplified frontend version used for display in lists and cards.
 * Differences from SharedPerpMarket (from @polyagent/shared):
 * - PerpMarket: Fewer fields, used for UI display (lists, cards, modals)
 * - SharedPerpMarket: Full API response with all fields (orderbook, trades, etc.)
 *
 * Use PerpMarket for components, SharedPerpMarket for API type validation.
 */
export interface PerpMarket {
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
  fundingRate: {
    rate: number;
    nextFundingTime: string;
    predictedRate: number;
  };
  maxLeverage: number;
  minOrderSize: number;
}

/**
 * Prediction market data structure from API.
 */
export interface PredictionMarket {
  id: number | string;
  text: string;
  status: "active" | "resolved" | "cancelled";
  createdDate?: string;
  resolutionDate?: string;
  resolvedOutcome?: boolean;
  scenario: number;
  yesShares?: number;
  noShares?: number;
  tradeCount?: number;
  oracleCommitTxHash?: string | null;
  oracleRevealTxHash?: string | null;
  oraclePublishedAt?: string | null;
}

/**
 * Extended prediction market with user position data.
 * Used in dashboard and list views where markets include user-specific position info.
 */
export interface PredictionMarketWithPosition extends PredictionMarket {
  /** Single user position (legacy format) */
  userPosition?: UserPredictionPosition | null;
  /** Array of user positions (current format) */
  userPositions?: UserPredictionPosition[];
}

// =============================================================================
// Trading Types
// =============================================================================

/**
 * Side of a perpetual trade position (frontend format).
 *
 * Note: API responses use lowercase 'long' | 'short' (matches PerpPositionFromAPI in @polyagent/shared).
 * This is consistent with the PerpPosition type and UI conventions.
 */
export type TradeSide = "long" | "short";

/**
 * Side of a prediction market position.
 */
export type PredictionSide = "YES" | "NO";

/**
 * Market category type for PnL displays and filters.
 */
export type MarketCategory = "perps" | "predictions";

// =============================================================================
// UI Types
// =============================================================================

/**
 * Tab options for the markets page.
 */
export type MarketTab = "dashboard" | "perps" | "predictions";

/**
 * Sort options for prediction markets list.
 */
export type PredictionSort = "trending" | "newest" | "ending-soon" | "volume";

/**
 * Sort options for perp markets list.
 */
export type PerpSort = "volume" | "change" | "name" | "price";

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Standard API error response structure.
 */
export interface ApiErrorResponse {
  /** Error field - string message or object with required message */
  error?: string | { message: string; code?: string };
  /** Alternative message field used by some endpoints */
  message?: string;
}

/**
 * Success response for sell shares operation.
 * Returns PnL from the sale for display in success messages.
 */
export interface SellSharesSuccessResponse {
  /** Realized profit/loss from the sale */
  pnl: number;
}

/**
 * Success response for buy shares operation.
 */
export interface BuySharesSuccessResponse {
  success: true;
  purchase: {
    id: string;
    cost: number;
    shares: number;
    side: PredictionSide;
  };
}

// =============================================================================
// Position Types for Components
// =============================================================================

/**
 * Perp position structure for display in lists.
 */
export interface DisplayPerpPosition {
  id: string;
  ticker: string;
  side: TradeSide;
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  liquidationPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  fundingPaid: number;
  openedAt: string;
}

// =============================================================================
// History/Chart Types
// =============================================================================

/**
 * Supported time ranges for market charts and history queries.
 */
export type MarketTimeRange = "1H" | "4H" | "1D" | "1W" | "ALL";

export const MARKET_TIME_RANGES: MarketTimeRange[] = [
  "1H",
  "4H",
  "1D",
  "1W",
  "ALL",
];

/**
 * Price point for perp price charts.
 */
export interface PerpHistoryPoint {
  /** Timestamp in milliseconds */
  time: number;
  /** Price at this timestamp */
  price: number;
}

/**
 * Price point for prediction probability charts.
 */
export interface PredictionHistoryPoint {
  /** Timestamp in milliseconds */
  time: number;
  /** YES price (0-1) */
  yesPrice: number;
  /** NO price (0-1) */
  noPrice: number;
}

// =============================================================================
// SSE Event Types
// =============================================================================

/**
 * SSE event for prediction market trades.
 */
export interface PredictionTradeSSE {
  type: "prediction_trade";
  marketId: string;
  userId: string;
  side: PredictionSide;
  shares: number;
  price: number;
  timestamp: string;
}

/**
 * SSE event for prediction market resolution.
 */
export interface PredictionResolutionSSE {
  type: "prediction_resolution";
  marketId: string;
  outcome: boolean;
  timestamp: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Configuration constants for markets feature.
 */
export const MARKETS_CONFIG = {
  /** Cache TTL for market data in milliseconds */
  CACHE_TTL_MS: 10_000,

  /** Default polling interval for market data in milliseconds */
  DEFAULT_POLLING_INTERVAL_MS: 30_000,

  /** Minimum polling interval allowed in milliseconds */
  MIN_POLLING_INTERVAL_MS: 5_000,

  /** Number of top movers to display */
  TOP_MOVERS_COUNT: 4,

  /** Number of trending markets to display */
  TRENDING_MARKETS_COUNT: 6,

  /** Maximum leverage for perp positions */
  MAX_LEVERAGE: 100,

  /** Minimum order size in USD */
  MIN_ORDER_SIZE_USD: 1,

  /** Default leverage for new positions */
  DEFAULT_LEVERAGE: 10,

  /** Liquidation threshold (0.9 = 90% of margin lost) */
  LIQUIDATION_THRESHOLD: 0.9,

  /** Chart sparkline dimensions */
  SPARKLINE: {
    WIDTH: 80,
    HEIGHT: 28,
  },

  /** Number of price decimal places for display */
  PRICE_DECIMALS: 2,

  /** Number of percent decimal places for display */
  PERCENT_DECIMALS: 2,
} as const;

/**
 * Type for MARKETS_CONFIG values.
 */
export type MarketsConfig = typeof MARKETS_CONFIG;
