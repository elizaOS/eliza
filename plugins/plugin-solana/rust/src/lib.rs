#![allow(missing_docs)]
//! elizaOS Plugin Solana - Rust Implementation

#![warn(missing_docs)]
#![deny(unsafe_code)]
#![forbid(clippy::unwrap_used)]

pub mod actions;
pub mod client;
pub mod error;
pub mod keypair;
pub mod providers;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export main types for convenience
pub use actions::{SwapAction, TransferAction};
pub use client::SolanaClient;
pub use error::{SolanaError, SolanaResult};
pub use keypair::{KeypairUtils, WalletConfig};
pub use providers::WalletProvider;
pub use types::SwapQuoteParams;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "chain_solana";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Default Solana RPC URL
pub const DEFAULT_RPC_URL: &str = "https://api.mainnet-beta.solana.com";
/// Wrapped SOL mint address
pub const WRAPPED_SOL_MINT: &str = "So11111111111111111111111111111111111111112";
/// USDC mint address
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
