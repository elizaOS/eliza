/**
 * Transport-level DTO types shared between the wallet HTTP routes and their
 * consumers: export request/rejection shapes, the market-overview response
 * (price snapshots, movers, Polymarket predictions) served by
 * `wallet-market-overview-route.ts`, the read-only crypto terminal market
 * list and price history served by `wallet-terminal-market-route.ts`, and the
 * Solana token safety report served by `wallet-terminal-token-safety-route.ts`.
 */
export interface WalletExportRequestBody {
  confirm?: boolean;
  exportToken?: string;
}

export interface WalletExportRejection {
  status: 400 | 401 | 402 | 403 | 429;
  reason: string;
}

export interface WalletMarketPriceSnapshot {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  imageUrl: string | null;
}

export interface WalletMarketMover {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
}

export interface WalletMarketPrediction {
  id: string;
  slug: string | null;
  question: string;
  highlightedOutcomeLabel: string;
  highlightedOutcomeProbability: number | null;
  volume24hUsd: number;
  totalVolumeUsd: number | null;
  endsAt: string | null;
  imageUrl: string | null;
}

export type WalletMarketOverviewProviderId = "coingecko" | "polymarket";

export interface WalletMarketOverviewSource {
  providerId: WalletMarketOverviewProviderId;
  providerName: string;
  providerUrl: string;
  available: boolean;
  stale: boolean;
  error: string | null;
}

export interface WalletMarketOverviewResponse {
  generatedAt: string;
  cacheTtlSeconds: number;
  stale: boolean;
  sources: {
    prices: WalletMarketOverviewSource;
    movers: WalletMarketOverviewSource;
    predictions: WalletMarketOverviewSource;
  };
  prices: WalletMarketPriceSnapshot[];
  movers: WalletMarketMover[];
  predictions: WalletMarketPrediction[];
}

/** One row of the crypto terminal market list (CoinGecko top market cap). */
export interface WalletTerminalMarket {
  id: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number;
  marketCapRank: number | null;
  imageUrl: string | null;
}

/** Response from GET /api/wallet/terminal/markets. */
export interface WalletTerminalMarketsResponse {
  generatedAt: string;
  stale: boolean;
  source: WalletMarketOverviewSource;
  markets: WalletTerminalMarket[];
}

/** Price-history windows the terminal chart supports, in days. */
export type WalletTerminalChartDays = 1 | 7 | 30 | 90 | 365;

/** One USD price observation; `t` is epoch milliseconds. */
export interface WalletTerminalChartPoint {
  t: number;
  priceUsd: number;
}

/** Response from GET /api/wallet/terminal/chart. */
export interface WalletTerminalChartResponse {
  id: string;
  days: WalletTerminalChartDays;
  generatedAt: string;
  stale: boolean;
  source: WalletMarketOverviewSource;
  points: WalletTerminalChartPoint[];
}

/** Where a token safety report came from and whether it is current. */
export interface WalletTokenSafetySource {
  providerId: "goplus";
  providerName: string;
  providerUrl: string;
  available: boolean;
  stale: boolean;
  error: string | null;
}

/**
 * One check's outcome. `danger` is a power that can take or lock holder funds,
 * `warn` is a risk worth weighing, `unknown` means the provider did not report
 * the field, and `ok` means the provider reported it as absent.
 */
export type WalletTokenSafetySeverity = "danger" | "warn" | "unknown" | "ok";

/** Overall reading: any danger → avoid; any warn or unknown → caution. */
export type WalletTokenSafetyVerdict = "avoid" | "caution" | "no-major-flags";

export interface WalletTokenSafetyCheck {
  id: string;
  label: string;
  severity: WalletTokenSafetySeverity;
  detail: string;
}

/** Response from GET /api/wallet/terminal/token-safety. */
export interface WalletTerminalTokenSafetyResponse {
  mint: string;
  name: string | null;
  symbol: string | null;
  generatedAt: string;
  stale: boolean;
  source: WalletTokenSafetySource;
  verdict: WalletTokenSafetyVerdict;
  checks: WalletTokenSafetyCheck[];
  holderCount: number | null;
  /** Share of supply held by the ten largest holders, as a percentage. */
  top10HolderPct: number | null;
  /** Sum of reported pool TVL across DEXes, in USD. */
  liquidityUsd: number | null;
  /** GoPlus marks a small set of well-known tokens as trusted. */
  trustedToken: boolean;
}
