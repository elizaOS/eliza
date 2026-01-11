#![allow(missing_docs)]
//! elizaOS Plugin Solana - Rust Implementation
//!
//! This crate provides Solana blockchain operations for elizaOS, including:
//! - Wallet management and key derivation
//! - SOL and SPL token transfers
//! - Token swaps via Jupiter
//! - Portfolio tracking and balance queries
//!
//! # Features
//!
//! - `native` (default): Enables full async runtime with tokio
//! - `wasm`: Enables WebAssembly support for browser environments
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_solana::{SolanaClient, WalletConfig};
//!
//! async fn example() -> anyhow::Result<()> {
//!     let config = WalletConfig::from_env()?;
//!     let client = SolanaClient::new(config)?;
//!     
//!     let balance = client.get_sol_balance().await?;
//!     println!("SOL balance: {}", balance);
//!     
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]
#![forbid(clippy::unwrap_used)]

pub mod client;
pub mod error;
pub mod keypair;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Import directly from submodules:
// - client::SolanaClient
// - error::{SolanaError, SolanaResult}
// - keypair::{KeypairUtils, WalletConfig}
// - types::* for all types

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


