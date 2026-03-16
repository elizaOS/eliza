#![allow(missing_docs)]
//! # elizaOS Plugin Polymarket
//!
//! Rust implementation of the Polymarket prediction markets plugin for elizaOS.
//!
//! This crate provides:
//! - Market data retrieval and browsing
//! - Order book access and pricing
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
//! ```rust,no_run
//! use elizaos_plugin_polymarket::client::ClobClient;
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let client = ClobClient::new(
//!         Some("https://clob.polymarket.com"),
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

pub mod actions;
pub mod client;
pub mod constants;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

/// The canonical plugin identifier used by elizaOS to refer to this plugin.
pub const PLUGIN_NAME: &str = "polymarket";

/// The plugin crate version (from `CARGO_PKG_VERSION`).
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

pub use service::PolymarketService;
