#![allow(missing_docs)]
//! Constants for the EVM plugin

use alloy::primitives::Address;

/// Cache key for wallet data storage
pub const EVM_WALLET_DATA_CACHE_KEY: &str = "evm/wallet/data";

/// Service name for the EVM service registration
pub const EVM_SERVICE_NAME: &str = "evmService";

/// Cache refresh interval in seconds
pub const CACHE_REFRESH_INTERVAL_SECS: u64 = 60;

/// Default gas buffer multiplier (20% extra)
pub const GAS_BUFFER_MULTIPLIER: f64 = 1.2;

/// Default gas price multiplier for MEV protection (10% extra)
pub const GAS_PRICE_MULTIPLIER: f64 = 1.1;

/// Maximum slippage percentage for swaps (5%)
pub const MAX_SLIPPAGE_PERCENT: f64 = 0.05;

/// Default slippage for swaps (1%)
pub const DEFAULT_SLIPPAGE_PERCENT: f64 = 0.01;

/// Maximum price impact for bridges (40%)
pub const MAX_PRICE_IMPACT: f64 = 0.4;

/// Transaction confirmation timeout in seconds
pub const TX_CONFIRMATION_TIMEOUT_SECS: u64 = 60;

/// Bridge status polling interval in seconds
pub const BRIDGE_POLL_INTERVAL_SECS: u64 = 5;

/// Maximum bridge status polling attempts
pub const MAX_BRIDGE_POLL_ATTEMPTS: u32 = 60;

/// Native token address (zero address)
pub const NATIVE_TOKEN_ADDRESS: Address = Address::ZERO;

/// LiFi API base URL
pub const LIFI_API_URL: &str = "https://li.quest/v1";

/// Bebop API base URL
pub const BEBOP_API_URL: &str = "https://api.bebop.xyz/router";

/// Standard ERC20 decimals
pub const DEFAULT_DECIMALS: u8 = 18;

/// Default chains if none are configured
pub const DEFAULT_CHAINS: &[&str] = &["mainnet", "base"];


