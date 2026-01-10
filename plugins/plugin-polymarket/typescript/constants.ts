/**
 * @elizaos/plugin-polymarket Constants
 *
 * Shared constants for the Polymarket plugin.
 */

// =============================================================================
// Chain Configuration
// =============================================================================

/** Polymarket operates on Polygon Mainnet */
export const POLYGON_CHAIN_ID = 137;

/** Chain name for integration with plugin-evm */
export const POLYGON_CHAIN_NAME = "polygon";

// =============================================================================
// API Configuration
// =============================================================================

/** Default CLOB API URL */
export const DEFAULT_CLOB_API_URL = "https://clob.polymarket.com";

/** Default WebSocket URL */
export const DEFAULT_CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/";

/** Gamma API URL for additional market data */
export const GAMMA_API_URL = "https://gamma-api.polymarket.com";

// =============================================================================
// Service Configuration
// =============================================================================

/** Service name for runtime registration */
export const POLYMARKET_SERVICE_NAME = "polymarket";

/** Cache key for wallet data */
export const POLYMARKET_WALLET_DATA_CACHE_KEY = "polymarket_wallet_data";

/** Cache refresh interval in milliseconds (5 minutes) */
export const CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Default request timeout in milliseconds */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** LLM call timeout in milliseconds */
export const LLM_CALL_TIMEOUT_MS = 60_000;

// =============================================================================
// Order Configuration
// =============================================================================

/** Default fee rate in basis points */
export const DEFAULT_FEE_RATE_BPS = "0";

/** Minimum order size for most markets */
export const DEFAULT_MIN_ORDER_SIZE = "5";

/** Maximum price value (1.0 = 100%) */
export const MAX_PRICE = 1.0;

/** Minimum price value */
export const MIN_PRICE = 0.0;

// =============================================================================
// USDC Configuration
// =============================================================================

/** USDC contract address on Polygon */
export const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/** USDC decimals */
export const USDC_DECIMALS = 6;

// =============================================================================
// CTF (Conditional Tokens Framework) Configuration
// =============================================================================

/** CTF Exchange contract address on Polygon */
export const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

/** Neg Risk CTF Exchange address */
export const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

/** Neg Risk Adapter address */
export const NEG_RISK_ADAPTER_ADDRESS = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// =============================================================================
// WebSocket Configuration
// =============================================================================

/** WebSocket ping interval in milliseconds */
export const WS_PING_INTERVAL_MS = 30_000;

/** WebSocket reconnect delay in milliseconds */
export const WS_RECONNECT_DELAY_MS = 5_000;

/** Maximum WebSocket reconnect attempts */
export const WS_MAX_RECONNECT_ATTEMPTS = 5;

// =============================================================================
// Pagination Defaults
// =============================================================================

/** Default page limit for API requests */
export const DEFAULT_PAGE_LIMIT = 100;

/** Maximum page limit for API requests */
export const MAX_PAGE_LIMIT = 500;

/** End of pagination marker */
export const END_CURSOR = "LTE=";

