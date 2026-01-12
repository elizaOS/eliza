#![allow(missing_docs)]
#![deny(unsafe_code)]

pub mod types;
pub mod constants;
pub mod providers;
pub mod actions;
pub mod error;

#[cfg(feature = "wasm")]
pub mod wasm;

pub const PLUGIN_NAME: &str = "evm";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

// Re-exports for convenience
pub use actions::{
    BridgeAction, BridgeParams, SwapAction, SwapParams, TransferAction, TransferParams,
};
pub use providers::{WalletProvider, WalletProviderConfig};
pub use types::SupportedChain;


