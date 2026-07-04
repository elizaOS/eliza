/**
 * Shared string constants and response/DTO types for the Hyperliquid plugin:
 * guidance/error copy for credential and execution states, and the typed
 * shapes of every `/api/hyperliquid/*` route response (status, markets,
 * funding, positions, orders). Consumed by `routes.ts`, `client.ts`, the
 * `PERPETUAL_MARKET` action, and the React/TUI views — this is the single
 * source of truth for those shapes so route, client, and UI stay in sync.
 */
export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";

export const HYPERLIQUID_EXECUTION_BLOCKED_REASON =
	"Signed Hyperliquid exchange mutations are disabled until the native app has a real managed or local execution path.";

export const HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON =
	"A signer is available, but signed Hyperliquid exchange execution remains disabled in this native app.";

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

export interface HyperliquidFundingRate {
	coin: string;
	index: number;
	funding: string;
	premium: string | null;
	markPx: string | null;
	oraclePx: string | null;
	openInterest: string | null;
}

export interface HyperliquidFundingResponse {
	rates: HyperliquidFundingRate[];
	source: "hyperliquid-info-meta-and-asset-ctxs";
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
	/**
	 * Current mark price, derived server-side as `|positionValue| / |size|`.
	 * Stringified USD; null when either input is unreadable.
	 */
	markPx: string | null;
	/**
	 * Distance from the current mark to the liquidation price, as a percent of
	 * mark (bigger = safer). Computed server-side against the real mark (not the
	 * entry price), so the view never does financial math. Null when mark or
	 * liquidation price are unreadable.
	 */
	distanceToLiquidationPct: number | null;
}

/**
 * Account-level margin summary derived from the Hyperliquid
 * `clearinghouseState` `marginSummary` block. Mirrors the waifu patron
 * "account health" strip (account value, withdrawable, total notional,
 * aggregate unrealized PnL) so the AppView can render the same hero stats.
 * All values are stringified USD as returned by Hyperliquid; null when the
 * account has never traded or the field is absent.
 */
export interface HyperliquidAccountSummary {
	accountValue: string | null;
	totalNotionalPosition: string | null;
	totalMarginUsed: string | null;
	totalRawUsd: string | null;
	withdrawable: string | null;
	/** Sum of per-position unrealized PnL, in USD. Null when unreadable. */
	totalUnrealizedPnl: string | null;
	/**
	 * Effective account leverage = `totalNotionalPosition / accountValue`,
	 * computed server-side. Null when either input is unreadable or account value
	 * is non-positive.
	 */
	effectiveLeverage: number | null;
}

export interface HyperliquidPositionsResponse {
	accountAddress: string | null;
	positions: HyperliquidPosition[];
	/**
	 * Account margin/value summary. Optional for back-compat: older route
	 * builds and the no-account path omit it (null).
	 */
	summary: HyperliquidAccountSummary | null;
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
