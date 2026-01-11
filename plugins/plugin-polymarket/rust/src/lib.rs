#![allow(missing_docs)]
//! # elizaOS Plugin Polymarket
//!
//! Rust implementation of the Polymarket prediction markets plugin for elizaOS.
//!
//! This crate provides:
//! - Market data retrieval and browsing
//! - Order book access and pricing
//! - Order placement and management
//! - WebSocket support for real-time updates
//! - Integration with alloy-rs for Polygon chain operations
//!
//! ## Features
//!
//! - `native` (default): Enables native async runtime with tokio
//! - `wasm`: Enables WebAssembly support with wasm-bindgen
//!
//! ## Example
//!
//! ```rust,ignore
//! use elizaos_plugin_polymarket::{ClobClient, OrderParams, OrderSide};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let client = ClobClient::new(
//!         "https://clob.polymarket.com",
//!         "0x...",  // private key
//!     ).await?;
//!
//!     // Get markets
//!     let markets = client.get_markets(None).await?;
//!     println!("Found {} markets", markets.data.len());
//!
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod types;
pub mod constants;
pub mod error;
pub mod client;
pub mod actions;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export main types
pub use types::*;
pub use constants::*;
pub use error::{PolymarketError, PolymarketErrorCode};
pub use client::ClobClient;
pub use actions::*;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "polymarket";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");







