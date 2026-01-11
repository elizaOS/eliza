#![allow(missing_docs)]
//! elizaOS Roblox Plugin - Rust Implementation
//!
//! This crate provides a Roblox client for elizaOS, enabling agents to
//! communicate with Roblox games via the Open Cloud API.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_roblox::{RobloxClient, RobloxConfig};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = RobloxConfig::from_env()?;
//!     let client = RobloxClient::new(config)?;
//!
//!     client.send_message("Hello from Eliza!", None).await?;
//!
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "native")]
pub mod service;

#[cfg(feature = "native")]
pub mod actions;

#[cfg(feature = "native")]
pub mod providers;

#[cfg(feature = "wasm")]
pub mod wasm;

// Import directly from submodules:
// - client::RobloxClient
// - config::RobloxConfig
// - error::{RobloxError, Result}
// - types::{DataStoreEntry, RobloxEventType, RobloxGameMessage, etc.}
// - service::RobloxService (with "native" feature)

/// Create a Roblox client from environment variables.
///
/// # Errors
///
/// Returns an error if required environment variables are not set.
pub fn create_client_from_env() -> Result<RobloxClient> {
    let config = RobloxConfig::from_env()?;
    RobloxClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "roblox";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Roblox integration for elizaOS - game communication via Open Cloud API";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Service name for registration
pub const ROBLOX_SERVICE_NAME: &str = "roblox";
/// Source identifier for messages
pub const ROBLOX_SOURCE: &str = "roblox";

/// Default configuration constants
pub mod defaults {
    /// Default messaging topic
    pub const MESSAGING_TOPIC: &str = "eliza-agent";
    /// Default polling interval in seconds
    pub const POLL_INTERVAL: u64 = 30;
}







