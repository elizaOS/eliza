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
  category: string;
  end_date_iso: string;
  game_start_time: string;
  question: string;
  market_slug: string;
  min_incentive_size: string;
  max_incentive_spread: string;
  active: boolean;
  closed: boolean;
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

export interface BookParams {
  token_id: string;
  side?: "buy" | "sell";
}
