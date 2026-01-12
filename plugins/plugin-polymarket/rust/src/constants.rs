#![allow(missing_docs)]

pub const POLYGON_CHAIN_ID: u64 = 137;
pub const POLYGON_CHAIN_NAME: &str = "polygon";

pub const DEFAULT_CLOB_API_URL: &str = "https://clob.polymarket.com";
pub const DEFAULT_CLOB_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/";
pub const GAMMA_API_URL: &str = "https://gamma-api.polymarket.com";

pub const POLYMARKET_SERVICE_NAME: &str = "polymarket";
pub const POLYMARKET_WALLET_DATA_CACHE_KEY: &str = "polymarket_wallet_data";
pub const CACHE_REFRESH_INTERVAL_SECS: u64 = 5 * 60;
pub const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 30;
pub const LLM_CALL_TIMEOUT_SECS: u64 = 60;

pub const DEFAULT_FEE_RATE_BPS: u32 = 0;
pub const DEFAULT_MIN_ORDER_SIZE: &str = "5";
pub const MAX_PRICE: f64 = 1.0;
pub const MIN_PRICE: f64 = 0.0;

pub const USDC_ADDRESS: &str = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
pub const USDC_DECIMALS: u8 = 6;

pub const CTF_EXCHANGE_ADDRESS: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
pub const NEG_RISK_CTF_EXCHANGE_ADDRESS: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
pub const NEG_RISK_ADAPTER_ADDRESS: &str = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

pub const WS_PING_INTERVAL_SECS: u64 = 30;
pub const WS_RECONNECT_DELAY_SECS: u64 = 5;
pub const WS_MAX_RECONNECT_ATTEMPTS: u32 = 5;

pub const DEFAULT_PAGE_LIMIT: u32 = 100;
pub const MAX_PAGE_LIMIT: u32 = 500;
pub const END_CURSOR: &str = "LTE=";
