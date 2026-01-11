//! Constants for the Polymarket plugin

// =============================================================================
// Chain Configuration
// =============================================================================

/// Polymarket operates on Polygon Mainnet
pub const POLYGON_CHAIN_ID: u64 = 137;

/// Chain name for integration with plugin-evm
pub const POLYGON_CHAIN_NAME: &str = "polygon";

// =============================================================================
// API Configuration
// =============================================================================

/// Default CLOB API URL
pub const DEFAULT_CLOB_API_URL: &str = "https://clob.polymarket.com";

/// Default WebSocket URL
pub const DEFAULT_CLOB_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/";

/// Gamma API URL for additional market data
pub const GAMMA_API_URL: &str = "https://gamma-api.polymarket.com";

// =============================================================================
// Service Configuration
// =============================================================================

/// Service name for runtime registration
pub const POLYMARKET_SERVICE_NAME: &str = "polymarket";

/// Cache key for wallet data
pub const POLYMARKET_WALLET_DATA_CACHE_KEY: &str = "polymarket_wallet_data";

/// Cache refresh interval in seconds (5 minutes)
pub const CACHE_REFRESH_INTERVAL_SECS: u64 = 5 * 60;

/// Default request timeout in seconds
pub const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 30;

/// LLM call timeout in seconds
pub const LLM_CALL_TIMEOUT_SECS: u64 = 60;

// =============================================================================
// Order Configuration
// =============================================================================

/// Default fee rate in basis points
pub const DEFAULT_FEE_RATE_BPS: u32 = 0;

/// Minimum order size for most markets
pub const DEFAULT_MIN_ORDER_SIZE: &str = "5";

// =============================================================================
// USDC Configuration
// =============================================================================

/// USDC contract address on Polygon
pub const USDC_ADDRESS: &str = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/// USDC decimals
pub const USDC_DECIMALS: u8 = 6;

// =============================================================================
// CTF Configuration
// =============================================================================

/// CTF Exchange contract address on Polygon
pub const CTF_EXCHANGE_ADDRESS: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

/// Neg Risk CTF Exchange address
pub const NEG_RISK_CTF_EXCHANGE_ADDRESS: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

/// Neg Risk Adapter address
pub const NEG_RISK_ADAPTER_ADDRESS: &str = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// =============================================================================
// WebSocket Configuration
// =============================================================================

/// WebSocket ping interval in seconds
pub const WS_PING_INTERVAL_SECS: u64 = 30;

/// WebSocket reconnect delay in seconds
pub const WS_RECONNECT_DELAY_SECS: u64 = 5;

/// Maximum WebSocket reconnect attempts
pub const WS_MAX_RECONNECT_ATTEMPTS: u32 = 5;

// =============================================================================
// Pagination Defaults
// =============================================================================

/// Default page limit for API requests
pub const DEFAULT_PAGE_LIMIT: u32 = 100;

/// Maximum page limit for API requests
pub const MAX_PAGE_LIMIT: u32 = 500;

/// End of pagination marker
pub const END_CURSOR: &str = "LTE=";


