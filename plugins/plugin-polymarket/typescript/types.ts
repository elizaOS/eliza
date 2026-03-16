export interface Token {
  token_id: string;
  outcome: string;
}

export interface Rewards {
  min_size: number;
  max_spread: number;
  event_start_date: string;
  event_end_date: string;
  in_game_multiplier: number;
  reward_epoch: number;
}

export interface Market {
  condition_id: string;
  question_id: string;
  tokens: [Token, Token];
  rewards: Rewards;
  minimum_order_size: string;
  minimum_tick_size: string;
  /** Tags/categories for the market (from CLOB API) */
  tags: string[];
  end_date_iso: string;
  game_start_time: string;
  question: string;
  market_slug: string;
  min_incentive_size: string;
  max_incentive_spread: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  accepting_orders?: boolean;
  enable_order_book?: boolean;
  seconds_delay: number;
  icon: string;
  fpmm: string;
}

export interface SimplifiedMarket {
  condition_id: string;
  tokens: [Token, Token];
  rewards: Rewards;
  min_incentive_size: string;
  max_incentive_spread: string;
  active: boolean;
  closed: boolean;
}

export interface MarketsResponse {
  limit: number;
  count: number;
  next_cursor: string;
  data: Market[];
}

export interface SimplifiedMarketsResponse {
  limit: number;
  count: number;
  next_cursor: string;
  data: SimplifiedMarket[];
}

export interface BookEntry {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  bids: BookEntry[];
  asks: BookEntry[];
}

export interface TokenPrice {
  token_id: string;
  price: string;
}

export interface MarketFilters {
  category?: string;
  active?: boolean;
  limit?: number;
  next_cursor?: string;
}

export interface OrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  feeRateBps: string;
  nonce?: number;
}

export interface Trade {
  id: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  timestamp: string;
  status: "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED";
}

export interface Position {
  market: string;
  asset_id: string;
  size: string;
  average_price: string;
  realized_pnl: string;
  unrealized_pnl: string;
}

export interface Balance {
  asset: string;
  balance: string;
  symbol: string;
  decimals: number;
}

export interface ClobError {
  error: string;
  details?: string;
  status?: number;
}

export enum OrderSide {
  BUY = "BUY",
  SELL = "SELL",
}

export enum OrderType {
  GTC = "GTC",
  FOK = "FOK",
  GTD = "GTD",
  FAK = "FAK",
}

export interface OrderArgs {
  tokenId: string;
  side: OrderSide;
  price: number;
  size: number;
  feeRateBps?: string;
  expiration?: number;
  nonce?: number;
}

export interface SignedOrder {
  salt: number;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: string;
  signatureType: number;
  signature: string;
}

export interface OrderResponse {
  success: boolean;
  errorMsg?: string;
  orderId?: string;
  orderHashes?: string[];
  status?: "matched" | "delayed" | "unmatched";
}

export interface MarketOrderRequest {
  tokenId: string;
  side: OrderSide;
  amount: number;
  slippage?: number;
}

export enum OrderStatus {
  PENDING = "PENDING",
  OPEN = "OPEN",
  FILLED = "FILLED",
  PARTIALLY_FILLED = "PARTIALLY_FILLED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
  REJECTED = "REJECTED",
}

export interface DetailedOrder {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  associate_trades: string[];
  outcome: string;
  created_at: number;
  expiration: string;
  order_type: string;
}

export interface AreOrdersScoringRequest {
  order_ids: string[];
}

export type AreOrdersScoringResponse = Record<string, boolean>;

export interface GetOpenOrdersParams {
  id?: string;
  market?: string;
  asset_id?: string;
}

export interface OpenOrder {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  associate_trades: string[];
  outcome: string;
  created_at: number;
  expiration: string;
  order_type: string;
}

export interface GetTradesParams {
  id?: string;
  maker_address?: string;
  market?: string;
  asset_id?: string;
  before?: string;
  after?: string;
}

export interface TradeEntry {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: OrderSide;
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  bucket_index: number;
  owner: string;
  maker_address: string;
  transaction_hash: string;
  trader_side: "TAKER" | "MAKER";
}

export interface TradesResponse {
  data: TradeEntry[];
  next_cursor: string;
}

export interface ApiKey {
  key_id: string;
  label: string;
  type: "read_only" | "read_write";
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
  is_cert_whitelisted: boolean;
}

export interface ApiKeysResponse {
  api_keys: ApiKey[];
  cert_required: boolean;
}

export interface ClobApiKeysResponse {
  apiKeys: ApiKeyCreds[];
}

export interface ApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface PolymarketError extends Error {
  code?: string;
  details?: string;
  status?: number;
}

export interface AuthenticationStatus {
  hasPrivateKey: boolean;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  hasApiPassphrase: boolean;
  walletAddress?: string;
  isFullyAuthenticated: boolean;
  canReadMarkets: boolean;
  canTrade: boolean;
}

// =============================================================================
// Cached Account State Types
// =============================================================================

export interface BalanceAllowance {
  balance: string;
  allowance: string;
}

export interface AccountBalances {
  collateral: BalanceAllowance | null;
  conditionalTokens: Record<string, BalanceAllowance>;
}

export interface CachedAccountState {
  walletAddress: string;
  balances: AccountBalances;
  activeOrders: OpenOrder[];
  recentTrades: TradeEntry[];
  positions: Position[];
  /** Scoring status for active orders - true means order is eligible for rewards */
  orderScoringStatus: Record<string, boolean>;
  apiKeys: ApiKey[];
  certRequired: boolean | null;
  lastUpdatedAt: number;
  expiresAt: number;
}

export interface BookParams {
  token_id: string;
  side?: "buy" | "sell";
}

// =============================================================================
// Research Types for Async Deep Research Integration
// =============================================================================

/**
 * Status of market research
 */
export enum ResearchStatus {
  /** No research exists for this market */
  NONE = "none",
  /** Research task is currently running */
  IN_PROGRESS = "in_progress",
  /** Research completed, results available */
  COMPLETED = "completed",
  /** Research is stale and should be refreshed */
  EXPIRED = "expired",
  /** Research failed */
  FAILED = "failed",
}

/**
 * Trading recommendation from research analysis
 */
export interface ResearchRecommendation {
  /** Whether the research suggests trading */
  shouldTrade: boolean;
  /** Recommended position direction */
  direction?: "YES" | "NO";
  /** Confidence level 0-100 */
  confidence: number;
  /** Brief reasoning for the recommendation */
  reasoning: string;
}

/**
 * Source citation from research
 */
export interface ResearchSource {
  url: string;
  title: string;
}

/**
 * Complete research result for a market
 */
export interface ResearchResult {
  /** Full research report text */
  text: string;
  /** AI-generated 2-3 sentence summary */
  summary: string;
  /** Trading recommendation */
  recommendation?: ResearchRecommendation;
  /** Cited sources from the research */
  sources: ResearchSource[];
  /** Number of sources analyzed */
  sourcesCount: number;
}

/**
 * Market research record for storage
 */
export interface MarketResearch {
  /** Polymarket condition_id */
  marketId: string;
  /** The market question being researched */
  marketQuestion: string;
  /** Current status of the research */
  status: ResearchStatus;
  /** UUID of the running task (if IN_PROGRESS) */
  taskId?: string;
  /** OpenAI response ID */
  researchId?: string;
  /** Research results (if COMPLETED) */
  result?: ResearchResult;
  /** Timestamp when research started */
  startedAt?: number;
  /** Timestamp when research completed */
  completedAt?: number;
  /** Timestamp when research expires */
  expiresAt?: number;
  /** Error message if research failed */
  errorMessage?: string;
}

/**
 * Metadata for the research task
 */
export interface ResearchTaskMetadata {
  marketId: string;
  marketQuestion: string;
  researchPrompt: string;
  callbackAction?: "EVALUATE_TRADE" | "NOTIFY_ONLY";
  tradeParams?: {
    tokenId: string;
    maxSize?: number;
    roomId?: string;
  };
  updatedAt: number;
  createdAt: number;
}

/**
 * Parameters for starting market research
 */
export interface StartResearchParams {
  marketId: string;
  marketQuestion: string;
  forceRefresh?: boolean;
  callbackAction?: "EVALUATE_TRADE" | "NOTIFY_ONLY";
  tradeParams?: ResearchTaskMetadata["tradeParams"];
}

// =============================================================================
// Activity Cursor Types - Track last viewed items for context continuity
// =============================================================================

/**
 * Activity type identifiers for tracking what the agent was doing
 */
export type ActivityType =
  | "markets_list"
  | "market_details"
  | "order_details"
  | "price_history"
  | "trade_history"
  | "order_scoring";

/**
 * Summary of markets that were viewed
 */
export interface MarketsActivityData {
  type: "markets_list";
  mode: "standard" | "simplified" | "sampling_random" | "sampling_rewards" | "search" | "browse";
  count: number;
  /** Category/tag filter that was applied */
  tags?: string[];
  activeOnly?: boolean;
  /** First few market summaries for context */
  markets: Array<{
    conditionId: string;
    question: string;
    active: boolean;
    closed: boolean;
  }>;
  nextCursor?: string;
}

/**
 * Details of a specific market that was viewed
 */
export interface MarketDetailsActivityData {
  type: "market_details";
  conditionId: string;
  question: string;
  /** Tags/categories for the market */
  tags: string[];
  active: boolean;
  closed: boolean;
  tokens?: Array<{
    tokenId: string;
    outcome: string;
  }>;
}

/**
 * Order details that were viewed
 */
export interface OrderDetailsActivityData {
  type: "order_details";
  orderId: string;
  status: string;
  side: string;
  price: string;
  originalSize: string;
  sizeMatched: string;
  market?: string;
  assetId?: string;
}

/**
 * Price history that was viewed
 */
export interface PriceHistoryActivityData {
  type: "price_history";
  tokenId: string;
  dataPoints: number;
  startTs: number;
  endTs: number;
  startPrice?: string;
  endPrice?: string;
  priceChangePercent?: string;
}

/**
 * Trade history that was viewed
 */
export interface TradeHistoryActivityData {
  type: "trade_history";
  totalTrades: number;
  /** Most recent trades for context */
  recentTrades: Array<{
    tradeId: string;
    side: string;
    price: string;
    size: string;
    market?: string;
  }>;
  filterMarket?: string;
  filterAssetId?: string;
  nextCursor?: string;
}

/**
 * Order scoring check results
 */
export interface OrderScoringActivityData {
  type: "order_scoring";
  orderIds: string[];
  results: Record<string, boolean>;
  scoringCount: number;
  notScoringCount: number;
}

/**
 * Union type for all activity data
 */
export type ActivityData =
  | MarketsActivityData
  | MarketDetailsActivityData
  | OrderDetailsActivityData
  | PriceHistoryActivityData
  | TradeHistoryActivityData
  | OrderScoringActivityData;

/**
 * Activity cursor entry - represents a single recorded activity
 */
export interface ActivityCursor {
  /** Unix timestamp when this activity occurred */
  timestamp: number;
  /** The activity data */
  data: ActivityData;
}

/**
 * Collection of recent activities, organized by type
 * Each type stores only the most recent activity of that type
 */
export interface ActivityContext {
  /** Most recent activity of each type */
  lastActivities: Partial<Record<ActivityType, ActivityCursor>>;
  /** Ordered list of recent activities (most recent first, max 10) */
  recentHistory: ActivityCursor[];
  /** Last update timestamp */
  lastUpdatedAt: number;
}
