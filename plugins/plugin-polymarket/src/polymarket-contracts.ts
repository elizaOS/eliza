/**
 * Shared request/response interfaces and upstream API base URLs for the
 * Polymarket integration — the contract between `routes.ts` (producer),
 * `client.ts` (typed fetch), and the view/action consumers.
 */
export const POLYMARKET_GAMMA_API_BASE = "https://gamma-api.polymarket.com";
export const POLYMARKET_DATA_API_BASE = "https://data-api.polymarket.com";
export const POLYMARKET_CLOB_API_BASE = "https://clob.polymarket.com";

export const POLYMARKET_TRADING_ENV_VARS = [
  "POLYMARKET_PRIVATE_KEY",
  "CLOB_API_KEY",
  "CLOB_API_SECRET",
  "CLOB_API_PASSPHRASE",
] as const;

export type PolymarketTradingEnvVar =
  (typeof POLYMARKET_TRADING_ENV_VARS)[number];

export interface PolymarketReadiness {
  ready: boolean;
  reason: string | null;
}

export interface PolymarketTradingReadiness extends PolymarketReadiness {
  credentialsReady: boolean;
  missing: readonly PolymarketTradingEnvVar[];
}

export interface PolymarketAccountReadiness extends PolymarketReadiness {
  /**
   * The agent's Polygon wallet address used to read positions, resolved from
   * env (POLYMARKET_WALLET_ADDRESS / STEWARD_EVM_ADDRESS / managed EVM
   * address). Null when no address is configured, in which case position reads
   * require an explicit `user` query param.
   */
  address: string | null;
}

export interface PolymarketStatusResponse {
  publicReads: PolymarketReadiness & {
    gammaApiBase: string;
    dataApiBase: string;
  };
  /**
   * Position-read readiness. Readable whenever an account address is resolvable
   * (public Data API, no credentials needed). The address is surfaced so the
   * AppView can read the agent's own positions without prompting for a wallet.
   */
  account: PolymarketAccountReadiness;
  trading: PolymarketTradingReadiness & {
    clobApiBase: string;
  };
}

export type PolymarketSource =
  | {
      api: "gamma";
      endpoint: string;
    }
  | {
      api: "data";
      endpoint: string;
    }
  | {
      api: "clob";
      endpoint: string;
    };

export interface PolymarketMarketOutcome {
  name: string;
  price: string | null;
}

export interface PolymarketMarket {
  id: string;
  slug: string | null;
  question: string | null;
  description: string | null;
  category: string | null;
  active: boolean | null;
  closed: boolean | null;
  archived: boolean | null;
  restricted: boolean | null;
  enableOrderBook: boolean | null;
  conditionId: string | null;
  clobTokenIds: readonly string[];
  outcomes: readonly PolymarketMarketOutcome[];
  liquidity: string | null;
  volume: string | null;
  volume24hr: string | null;
  lastTradePrice: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  image: string | null;
  icon: string | null;
  endDate: string | null;
  startDate: string | null;
  updatedAt: string | null;
}

export interface PolymarketMarketsResponse {
  markets: readonly PolymarketMarket[];
  source: PolymarketSource;
}

export interface PolymarketMarketResponse {
  market: PolymarketMarket | null;
  source: PolymarketSource;
}

export interface PolymarketOrderbookLevel {
  price: string;
  size: string;
}

export interface PolymarketOrderbookResponse {
  tokenId: string;
  market: string | null;
  assetId: string | null;
  bids: readonly PolymarketOrderbookLevel[];
  asks: readonly PolymarketOrderbookLevel[];
  bestBid: string | null;
  bestBidSize: string | null;
  bestAsk: string | null;
  bestAskSize: string | null;
  midpoint: string | null;
  spread: string | null;
  bidLevels: number;
  askLevels: number;
  lastTradePrice: string | null;
  tickSize: string | null;
  source: PolymarketSource;
}

export interface PolymarketDisabledResponse {
  enabled: false;
  reason: string;
  requiredForTrading: readonly PolymarketTradingEnvVar[];
}

/**
 * Account-level aggregate derived from a wallet's open Polymarket positions,
 * mirroring the waifu patron "account health" strip (total position value +
 * aggregate cash PnL across markets). All values are stringified USD; null when
 * the wallet holds no positions or the field is unreadable. This is the
 * prediction-market analogue of the Hyperliquid account summary surfaced in the
 * sibling HL app-plugin.
 */
export interface PolymarketPositionsSummary {
  /** Sum of per-position `currentValue`, in USD. Null when no positions. */
  totalValue: string | null;
  /** Sum of per-position `cashPnl`, in USD. Null when no positions. */
  totalCashPnl: string | null;
  /**
   * Aggregate return as a fraction of cost basis
   * (totalCashPnl / (totalValue - totalCashPnl)). Null when the basis is
   * zero/unreadable.
   */
  totalPercentPnl: string | null;
  /** Count of open positions contributing to the aggregate. */
  openPositions: number;
}

export interface PolymarketPositionsResponse {
  positions: readonly PolymarketPosition[];
  /**
   * The wallet whose positions were read. Resolved from the request `user`
   * query param, or from the agent's configured Polygon address when omitted.
   * Null when no address was resolvable.
   */
  user: string | null;
  /**
   * Account value/PnL aggregate. Optional for back-compat: older route builds
   * and the no-position path emit null.
   */
  summary: PolymarketPositionsSummary | null;
  source: PolymarketSource;
}

export interface PolymarketPosition {
  marketId: string | null;
  conditionId: string | null;
  question: string | null;
  outcome: string | null;
  size: string | null;
  currentValue: string | null;
  cashPnl: string | null;
  percentPnl: string | null;
  icon: string | null;
  slug: string | null;
}
