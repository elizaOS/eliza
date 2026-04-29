export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";

export const HYPERLIQUID_EXECUTION_BLOCKED_REASON =
  "Set HYPERLIQUID_PRIVATE_KEY or HL_PRIVATE_KEY to prepare signed execution. This native app currently exposes read/status endpoints only.";

export const HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON =
  "Signed Hyperliquid exchange execution is not implemented in this native scaffold yet.";

export const HYPERLIQUID_ACCOUNT_BLOCKED_REASON =
  "Set HYPERLIQUID_ACCOUNT_ADDRESS or HL_ACCOUNT_ADDRESS to read account-specific positions and orders.";

export interface HyperliquidStatusResponse {
  publicReadReady: boolean;
  signerReady: boolean;
  executionReady: boolean;
  executionBlockedReason: string | null;
  accountAddress: string | null;
  apiBaseUrl: string;
}

export interface HyperliquidMarket {
  name: string;
  index: number;
  szDecimals: number;
  maxLeverage: number | null;
  onlyIsolated: boolean;
  isDelisted: boolean;
}

export interface HyperliquidMarketsResponse {
  markets: HyperliquidMarket[];
  source: "hyperliquid-info-meta";
  fetchedAt: string;
}

export interface HyperliquidPosition {
  coin: string;
  size: string;
  entryPx: string | null;
  positionValue: string | null;
  unrealizedPnl: string | null;
  returnOnEquity: string | null;
  liquidationPx: string | null;
  marginUsed: string | null;
  leverageType: string | null;
  leverageValue: number | null;
}

export interface HyperliquidPositionsResponse {
  accountAddress: string | null;
  positions: HyperliquidPosition[];
  readBlockedReason: string | null;
  fetchedAt: string | null;
}

export interface HyperliquidOrder {
  coin: string;
  side: string;
  limitPx: string;
  size: string;
  oid: number;
  timestamp: number;
  reduceOnly: boolean;
  orderType: string | null;
  tif: string | null;
  cloid: string | null;
}

export interface HyperliquidOrdersResponse {
  accountAddress: string | null;
  orders: HyperliquidOrder[];
  readBlockedReason: string | null;
  fetchedAt: string | null;
}

export interface HyperliquidExecutionDisabledResponse {
  executionReady: false;
  executionBlockedReason: string;
}
