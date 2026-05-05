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

export interface PolymarketStatusResponse {
  publicReads: PolymarketReadiness & {
    gammaApiBase: string;
    dataApiBase: string;
  };
  trading: PolymarketTradingReadiness & {
    clobApiBase: string;
  };
}

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
  source: {
    api: "gamma";
    endpoint: string;
  };
}

export interface PolymarketMarketResponse {
  market: PolymarketMarket | null;
  source: {
    api: "gamma";
    endpoint: string;
  };
}

export interface PolymarketDisabledResponse {
  enabled: false;
  reason: string;
  requiredForTrading: readonly PolymarketTradingEnvVar[];
}

export interface PolymarketPositionsResponse {
  positions: readonly PolymarketPosition[];
  source: {
    api: "data";
    endpoint: string;
  };
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
