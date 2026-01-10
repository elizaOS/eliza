//! # elizaOS Plugin EVM
//!
//! Rust implementation of the EVM blockchain plugin for elizaOS.
//!
//! This crate provides:
//! - Wallet management using alloy-rs
//! - Token transfers (native and ERC20)
//! - Token swaps via aggregator APIs
//! - Cross-chain bridges via LiFi API
//!
//! ## Features
//!
//! - `native` (default): Enables native async runtime with tokio
//! - `wasm`: Enables WebAssembly support with wasm-bindgen
//!
//! ## Example
//!
//! ```rust,ignore
//! use elizaos_plugin_evm::{WalletProvider, TransferAction, TransferParams};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let provider = WalletProvider::new(
//!         "0x...",  // private key
//!         vec!["mainnet", "base"],
//!         None,
//!     ).await?;
//!
//!     let transfer = TransferAction::new(provider);
//!     let result = transfer.execute(TransferParams {
//!         from_chain: "mainnet".parse()?,
//!         to_address: "0x...".parse()?,
//!         amount: "1.0".to_string(),
//!         data: None,
//!     }).await?;
//!
//!     println!("Transaction hash: {:?}", result.hash);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod types;
pub mod constants;
pub mod providers;
pub mod actions;
pub mod error;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export main types
pub use types::*;
pub use constants::*;
pub use error::{EVMError, EVMErrorCode};
pub use providers::wallet::{WalletProvider, WalletProviderConfig};
pub use actions::transfer::{TransferAction, TransferParams};
pub use actions::swap::{SwapAction, SwapParams, SwapQuote};
pub use actions::bridge::{BridgeAction, BridgeParams, BridgeStatus};

/// Plugin metadata
pub const PLUGIN_NAME: &str = "evm";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");


