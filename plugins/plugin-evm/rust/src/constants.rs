#![allow(missing_docs)]

use alloy::primitives::Address;

pub const EVM_WALLET_DATA_CACHE_KEY: &str = "evm/wallet/data";
pub const EVM_SERVICE_NAME: &str = "evmService";
pub const CACHE_REFRESH_INTERVAL_SECS: u64 = 60;
pub const GAS_BUFFER_MULTIPLIER: f64 = 1.2;
pub const GAS_PRICE_MULTIPLIER: f64 = 1.1;
pub const MAX_SLIPPAGE_PERCENT: f64 = 0.05;
pub const DEFAULT_SLIPPAGE_PERCENT: f64 = 0.01;
pub const MAX_PRICE_IMPACT: f64 = 0.4;
pub const TX_CONFIRMATION_TIMEOUT_SECS: u64 = 60;
pub const BRIDGE_POLL_INTERVAL_SECS: u64 = 5;
pub const MAX_BRIDGE_POLL_ATTEMPTS: u32 = 60;
pub const NATIVE_TOKEN_ADDRESS: Address = Address::ZERO;
pub const LIFI_API_URL: &str = "https://li.quest/v1";
pub const BEBOP_API_URL: &str = "https://api.bebop.xyz/router";
pub const DEFAULT_DECIMALS: u8 = 18;
pub const DEFAULT_CHAINS: &[&str] = &["mainnet", "base"];
