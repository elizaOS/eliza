/**
 * @elizaos/plugin-polymarket Type Definitions
 *
 * This module provides strongly typed definitions for all Polymarket operations.
 * Types are designed for fail-fast validation with Zod schemas.
 */

import { z } from "zod";

// =============================================================================
// Constants
// =============================================================================

/** Polymarket operates on Polygon Mainnet */
export const POLYGON_CHAIN_ID = 137;

/** Default CLOB API URL */
export const DEFAULT_CLOB_API_URL = "https://clob.polymarket.com";

/** Default WebSocket URL */
export const DEFAULT_CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/";

// =============================================================================
// Token Types
// =============================================================================

/**
 * Token object representing a binary outcome in a prediction market
 */
export interface Token {
  /** ERC1155 token ID */
  readonly token_id: string;
  /** Human readable outcome (e.g., "YES", "NO") */
  readonly outcome: string;
}

export const TokenSchema = z.object({
  token_id: z.string(),
  outcome: z.string(),
});

// =============================================================================
// Market Types
// =============================================================================

/**
 * Rewards configuration for a market
 */
export interface Rewards {
  /** Minimum size of an order to score rewards */
  readonly min_size: number;
  /** Maximum spread from the midpoint until an order scores */
  readonly max_spread: number;
  /** String date when the event starts */
  readonly event_start_date: string;
  /** String date when the event ends */
  readonly event_end_date: string;
  /** Reward multiplier while the game has started */
  readonly in_game_multiplier: number;
  /** Current reward epoch */
  readonly reward_epoch: number;
}

export const RewardsSchema = z.object({
  min_size: z.number(),
  max_spread: z.number(),
  event_start_date: z.string(),
  event_end_date: z.string(),
  in_game_multiplier: z.number(),
  reward_epoch: z.number(),
});

/**
 * Market object representing a Polymarket prediction market
 */
export interface Market {
  /** ID of market which is also the CTF condition ID */
  readonly condition_id: string;
  /** Question ID of market which is the CTF question ID */
  readonly question_id: string;
  /** Binary token pair for market */
  readonly tokens: readonly [Token, Token];
  /** Rewards related data */
  readonly rewards: Rewards;
  /** Minimum limit order size */
  readonly minimum_order_size: string;
  /** Minimum tick size in units of implied probability */
  readonly minimum_tick_size: string;
  /** Tags/categories for the market */
  readonly tags: readonly string[];
  /** ISO string of market end date */
  readonly end_date_iso: string;
  /** ISO string of game start time */
  readonly game_start_time: string;
  /** Market question */
  readonly question: string;
  /** Slug of market */
  readonly market_slug: string;
  /** Minimum resting order size for incentive qualification */
  readonly min_incentive_size: string;
  /** Max spread for incentive qualification */
  readonly max_incentive_spread: string;
  /** Whether market is active/live */
  readonly active: boolean;
  /** Whether market is closed */
  readonly closed: boolean;
  /** Seconds of match delay for in-game trade */
  readonly seconds_delay: number;
  /** Reference to the market icon image */
  readonly icon: string;
  /** Address of associated FPMM on Polygon */
  readonly fpmm: string;
}

export const MarketSchema = z.object({
  condition_id: z.string(),
  question_id: z.string(),
  tokens: z.tuple([TokenSchema, TokenSchema]),
  rewards: RewardsSchema,
  minimum_order_size: z.string(),
  minimum_tick_size: z.string(),
  tags: z.array(z.string()),
  end_date_iso: z.string(),
  game_start_time: z.string(),
  question: z.string(),
  market_slug: z.string(),
  min_incentive_size: z.string(),
  max_incentive_spread: z.string(),
  active: z.boolean(),
  closed: z.boolean(),
  seconds_delay: z.number(),
  icon: z.string(),
  fpmm: z.string(),
});

/**
 * Simplified market object with reduced fields
 */
export interface SimplifiedMarket {
  readonly condition_id: string;
  readonly tokens: readonly [Token, Token];
  readonly rewards: Rewards;
  readonly min_incentive_size: string;
  readonly max_incentive_spread: string;
  readonly active: boolean;
  readonly closed: boolean;
}

export const SimplifiedMarketSchema = z.object({
  condition_id: z.string(),
  tokens: z.tuple([TokenSchema, TokenSchema]),
  rewards: RewardsSchema,
  min_incentive_size: z.string(),
  max_incentive_spread: z.string(),
  active: z.boolean(),
  closed: z.boolean(),
});

// =============================================================================
// Order Book Types
// =============================================================================

/**
 * Order book entry
 */
export interface BookEntry {
  readonly price: string;
  readonly size: string;
}

export const BookEntrySchema = z.object({
  price: z.string(),
  size: z.string(),
});

/**
 * Order book data
 */
export interface OrderBook {
  readonly market: string;
  readonly asset_id: string;
  readonly bids: readonly BookEntry[];
  readonly asks: readonly BookEntry[];
}

export const OrderBookSchema = z.object({
  market: z.string(),
  asset_id: z.string(),
  bids: z.array(BookEntrySchema),
  asks: z.array(BookEntrySchema),
});

// =============================================================================
// Order Types
// =============================================================================

/**
 * Order side enumeration
 */
export enum OrderSide {
  BUY = "BUY",
  SELL = "SELL",
}

export const OrderSideSchema = z.nativeEnum(OrderSide);

/**
 * Order type enumeration
 */
export enum OrderType {
  /** Good Till Cancelled */
  GTC = "GTC",
  /** Fill Or Kill */
  FOK = "FOK",
  /** Good Till Date */
  GTD = "GTD",
  /** Fill And Kill */
  FAK = "FAK",
}

export const OrderTypeSchema = z.nativeEnum(OrderType);

/**
 * Order status
 */
export enum OrderStatus {
  PENDING = "PENDING",
  OPEN = "OPEN",
  FILLED = "FILLED",
  PARTIALLY_FILLED = "PARTIALLY_FILLED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
  REJECTED = "REJECTED",
}

export const OrderStatusSchema = z.nativeEnum(OrderStatus);

/**
 * Parameters for creating orders
 */
export interface OrderParams {
  readonly tokenId: string;
  readonly side: OrderSide;
  readonly price: number;
  readonly size: number;
  readonly orderType?: OrderType;
  readonly feeRateBps?: string;
  readonly expiration?: number;
  readonly nonce?: number;
}

export const OrderParamsSchema = z.object({
  tokenId: z.string().min(1, "Token ID is required"),
  side: OrderSideSchema,
  price: z.number().min(0).max(1, "Price must be between 0 and 1"),
  size: z.number().positive("Size must be positive"),
  orderType: OrderTypeSchema.optional().default(OrderType.GTC),
  feeRateBps: z.string().optional().default("0"),
  expiration: z.number().optional(),
  nonce: z.number().optional(),
});

/**
 * Signed order object
 */
export interface SignedOrder {
  readonly salt: number;
  readonly maker: string;
  readonly signer: string;
  readonly taker: string;
  readonly tokenId: string;
  readonly makerAmount: string;
  readonly takerAmount: string;
  readonly expiration: string;
  readonly nonce: string;
  readonly feeRateBps: string;
  readonly side: string;
  readonly signatureType: number;
  readonly signature: string;
}

/**
 * Order response from CLOB API
 */
export interface OrderResponse {
  readonly success: boolean;
  readonly errorMsg?: string;
  readonly orderId?: string;
  readonly orderHashes?: readonly string[];
  readonly status?: "matched" | "delayed" | "unmatched";
}

export const OrderResponseSchema = z.object({
  success: z.boolean(),
  errorMsg: z.string().optional(),
  orderId: z.string().optional(),
  orderHashes: z.array(z.string()).optional(),
  status: z.enum(["matched", "delayed", "unmatched"]).optional(),
});

/**
 * Open order details
 */
export interface OpenOrder {
  readonly order_id: string;
  readonly user_id: string;
  readonly market_id: string;
  readonly token_id: string;
  readonly side: OrderSide;
  readonly type: string;
  readonly status: string;
  readonly price: string;
  readonly size: string;
  readonly filled_size: string;
  readonly fees_paid: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Detailed order information
 */
export interface DetailedOrder extends OpenOrder {
  readonly is_cancelled: boolean;
  readonly is_taker: boolean;
  readonly is_active_order: boolean;
  readonly error_code?: string | null;
  readonly error_message?: string | null;
}

// =============================================================================
// Trade Types
// =============================================================================

/**
 * Trade data
 */
export interface Trade {
  readonly id: string;
  readonly market: string;
  readonly asset_id: string;
  readonly side: OrderSide;
  readonly price: string;
  readonly size: string;
  readonly timestamp: string;
  readonly status: "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";
}

export const TradeSchema = z.object({
  id: z.string(),
  market: z.string(),
  asset_id: z.string(),
  side: OrderSideSchema,
  price: z.string(),
  size: z.string(),
  timestamp: z.string(),
  status: z.enum(["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"]),
});

/**
 * Trade entry from history
 */
export interface TradeEntry {
  readonly trade_id: string;
  readonly order_id: string;
  readonly user_id: string;
  readonly market_id: string;
  readonly token_id: string;
  readonly side: OrderSide;
  readonly type: string;
  readonly price: string;
  readonly size: string;
  readonly fees_paid: string;
  readonly timestamp: string;
  readonly tx_hash: string;
}

// =============================================================================
// Position Types
// =============================================================================

/**
 * User position in a market
 */
export interface Position {
  readonly market: string;
  readonly asset_id: string;
  readonly size: string;
  readonly average_price: string;
  readonly realized_pnl: string;
  readonly unrealized_pnl: string;
}

export const PositionSchema = z.object({
  market: z.string(),
  asset_id: z.string(),
  size: z.string(),
  average_price: z.string(),
  realized_pnl: z.string(),
  unrealized_pnl: z.string(),
});

/**
 * User balance data
 */
export interface Balance {
  readonly asset: string;
  readonly balance: string;
  readonly symbol: string;
  readonly decimals: number;
}

export const BalanceSchema = z.object({
  asset: z.string(),
  balance: z.string(),
  symbol: z.string(),
  decimals: z.number(),
});

// =============================================================================
// API Key Types
// =============================================================================

/**
 * API key credentials
 */
export interface ApiKeyCreds {
  readonly key: string;
  readonly secret: string;
  readonly passphrase: string;
}

export const ApiKeyCredsSchema = z.object({
  key: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().min(1),
});

/**
 * API key details
 */
export interface ApiKey {
  readonly key_id: string;
  readonly label: string;
  readonly type: "read_only" | "read_write";
  readonly status: "active" | "revoked";
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly is_cert_whitelisted: boolean;
}

export const ApiKeySchema = z.object({
  key_id: z.string(),
  label: z.string(),
  type: z.enum(["read_only", "read_write"]),
  status: z.enum(["active", "revoked"]),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  is_cert_whitelisted: z.boolean(),
});

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Paginated response for markets API
 */
export interface MarketsResponse {
  readonly limit: number;
  readonly count: number;
  readonly next_cursor: string;
  readonly data: readonly Market[];
}

export const MarketsResponseSchema = z.object({
  limit: z.number(),
  count: z.number(),
  next_cursor: z.string(),
  data: z.array(MarketSchema),
});

/**
 * Paginated response for simplified markets
 */
export interface SimplifiedMarketsResponse {
  readonly limit: number;
  readonly count: number;
  readonly next_cursor: string;
  readonly data: readonly SimplifiedMarket[];
}

/**
 * Paginated response for trades
 */
export interface TradesResponse {
  readonly data: readonly TradeEntry[];
  readonly next_cursor: string;
}

/**
 * API keys response
 */
export interface ApiKeysResponse {
  readonly api_keys: readonly ApiKey[];
  readonly cert_required: boolean;
}

// =============================================================================
// Filter Types
// =============================================================================

/**
 * Filter parameters for markets API
 */
export interface MarketFilters {
  readonly category?: string;
  readonly active?: boolean;
  readonly limit?: number;
  readonly next_cursor?: string;
}

export const MarketFiltersSchema = z.object({
  category: z.string().optional(),
  active: z.boolean().optional(),
  limit: z.number().optional(),
  next_cursor: z.string().optional(),
});

/**
 * Parameters for getting trades
 */
export interface GetTradesParams {
  readonly user_address?: string;
  readonly market_id?: string;
  readonly token_id?: string;
  readonly from_timestamp?: number;
  readonly to_timestamp?: number;
  readonly limit?: number;
  readonly next_cursor?: string;
}

export const GetTradesParamsSchema = z.object({
  user_address: z.string().optional(),
  market_id: z.string().optional(),
  token_id: z.string().optional(),
  from_timestamp: z.number().optional(),
  to_timestamp: z.number().optional(),
  limit: z.number().optional(),
  next_cursor: z.string().optional(),
});

/**
 * Parameters for getting open orders
 */
export interface GetOpenOrdersParams {
  readonly market?: string;
  readonly assetId?: string;
  readonly address?: string;
  readonly nextCursor?: string;
}

export const GetOpenOrdersParamsSchema = z.object({
  market: z.string().optional(),
  assetId: z.string().optional(),
  address: z.string().optional(),
  nextCursor: z.string().optional(),
});

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error response from CLOB API
 */
export interface ClobError {
  readonly error: string;
  readonly details?: string;
  readonly status?: number;
}

export const ClobErrorSchema = z.object({
  error: z.string(),
  details: z.string().optional(),
  status: z.number().optional(),
});

/**
 * Polymarket-specific error codes
 */
export const PolymarketErrorCode = {
  INVALID_MARKET: "INVALID_MARKET",
  INVALID_TOKEN: "INVALID_TOKEN",
  INVALID_ORDER: "INVALID_ORDER",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  MARKET_CLOSED: "MARKET_CLOSED",
  API_ERROR: "API_ERROR",
  WEBSOCKET_ERROR: "WEBSOCKET_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
} as const;

export type PolymarketErrorCode = (typeof PolymarketErrorCode)[keyof typeof PolymarketErrorCode];

/**
 * Structured Polymarket error
 */
export class PolymarketError extends Error {
  constructor(
    public readonly code: PolymarketErrorCode,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "PolymarketError";
  }
}

// =============================================================================
// WebSocket Types
// =============================================================================

/**
 * WebSocket subscription type
 */
export type WebSocketSubscriptionType = "market" | "user" | "price" | "trade";

/**
 */
export interface WebSocketMessage {
  readonly type: string;
  readonly channel?: string;
  readonly data?: Record<string, unknown>;
  readonly error?: string;
}

export interface TokenPrice {
  readonly token_id: string;
  readonly price: string;
}

export const TokenPriceSchema = z.object({
  token_id: z.string(),
  price: z.string(),
});

/**
 * Price history entry
 */
export interface PriceHistoryEntry {
  readonly timestamp: string;
  readonly price: string;
  readonly volume?: string;
}

export const PriceHistoryEntrySchema = z.object({
  timestamp: z.string(),
  price: z.string(),
  volume: z.string().optional(),
});

export function parseOrderParams(input: unknown): OrderParams {
  return OrderParamsSchema.parse(input);
}

export function parseMarketFilters(input: unknown): MarketFilters {
  return MarketFiltersSchema.parse(input);
}

/**
 * Validate a condition ID format
 */
export function isValidConditionId(id: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(id);
}

/**
 * Validate a token ID format (can be numeric or hex)
 */
export function isValidTokenId(id: string): boolean {
  return /^\d+$/.test(id) || /^0x[a-fA-F0-9]+$/.test(id);
}
