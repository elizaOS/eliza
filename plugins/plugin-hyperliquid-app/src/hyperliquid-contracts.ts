export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";

export const HYPERLIQUID_EXECUTION_BLOCKED_REASON =
  "Signed Hyperliquid exchange mutations are disabled until the native app has a real managed or local execution path.";

export const HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON =
  "A signer is available, but signed Hyperliquid exchange execution is not implemented in this native app yet.";

export const HYPERLIQUID_ACCOUNT_BLOCKED_REASON =
  "Connect a managed Eliza Cloud vault or set HYPERLIQUID_ACCOUNT_ADDRESS / HL_ACCOUNT_ADDRESS to read account-specific positions and orders.";

export const HYPERLIQUID_VAULT_GUIDANCE =
  "Connect Eliza Cloud or Steward to use a managed vault. Public market reads do not require a vault.";

export const HYPERLIQUID_LOCAL_KEY_GUIDANCE =
  "Advanced optional path: set EVM_PRIVATE_KEY, HYPERLIQUID_PRIVATE_KEY, or HL_PRIVATE_KEY only when running a local signer intentionally. Public market reads do not require local keys.";

export const HYPERLIQUID_API_WALLET_GUIDANCE =
  "Optional Hyperliquid API-wallet delegation uses HYPERLIQUID_AGENT_KEY or HL_AGENT_KEY after a managed vault or local signer exists. It is not required for public reads.";

export type HyperliquidCredentialMode = "managed_vault" | "local_key" | "none";

export type HyperliquidAccountSource = "managed_vault" | "env_account" | "none";

export interface HyperliquidReadinessStatus {
  publicReads: boolean;
  accountReads: boolean;
  signer: boolean;
  execution: false;
}

export interface HyperliquidAccountStatus {
  address: string | null;
  source: HyperliquidAccountSource;
  guidance: string | null;
}

export interface HyperliquidVaultStatus {
  configured: boolean;
  ready: boolean;
  address: string | null;
  guidance: string;
}

export interface HyperliquidApiWalletStatus {
  configured: boolean;
  guidance: string;
}

export interface HyperliquidStatusResponse {
  publicReadReady: boolean;
  signerReady: boolean;
  executionReady: boolean;
  executionBlockedReason: string | null;
  accountAddress: string | null;
  apiBaseUrl: string;
  credentialMode: HyperliquidCredentialMode;
  readiness: HyperliquidReadinessStatus;
  account: HyperliquidAccountStatus;
  vault: HyperliquidVaultStatus;
  apiWallet: HyperliquidApiWalletStatus;
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
  credentialMode: HyperliquidCredentialMode;
}
