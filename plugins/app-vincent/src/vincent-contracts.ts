export type VincentStrategyName = "dca" | "rebalance" | "threshold" | "manual";

export type VincentTradingVenue = "hyperliquid" | "polymarket";

export const VINCENT_TRADING_VENUES: readonly VincentTradingVenue[] = [
  "hyperliquid",
  "polymarket",
] as const;

export interface VincentStartLoginResponse {
  authUrl: string;
  state: string;
  redirectUri: string;
}

export interface VincentStatusResponse {
  connected: boolean;
  connectedAt: number | null;
  tradingVenues: readonly VincentTradingVenue[];
}

export interface VincentStrategy {
  name: VincentStrategyName;
  venues: readonly VincentTradingVenue[];
  params: Record<string, unknown>;
  intervalSeconds: number;
  dryRun: boolean;
  running: boolean;
}

export interface VincentStrategyResponse {
  connected: boolean;
  strategy: VincentStrategy | null;
}

export interface VincentStrategyUpdateRequest {
  strategy?: VincentStrategyName;
  params?: Record<string, unknown>;
  intervalSeconds?: number;
  dryRun?: boolean;
}

export interface VincentStrategyUpdateResponse {
  ok: boolean;
  strategy: VincentStrategy | null;
}

export interface VincentTradingProfileTokenBreakdownItem {
  symbol: string;
  pnl: string;
  swaps: number;
}

export interface VincentTradingProfile {
  totalPnl: string;
  winRate: number;
  totalSwaps: number;
  volume24h: string;
  tokenBreakdown: VincentTradingProfileTokenBreakdownItem[];
}

export interface VincentTradingProfileResponse {
  connected: boolean;
  profile: VincentTradingProfile | null;
}
