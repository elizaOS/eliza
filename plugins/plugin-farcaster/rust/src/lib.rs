#![allow(missing_docs)]
//! elizaOS Farcaster Plugin - Rust Implementation
//!
//! This crate provides a Farcaster client for elizaOS, enabling agents to
//! send and receive casts on the Farcaster decentralized social network
//! via the Neynar API.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_farcaster::{FarcasterClient, FarcasterConfig};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = FarcasterConfig::from_env()?;
//!     let client = FarcasterClient::new(config)?;
//!
//!     let casts = client.send_cast("Hello Farcaster!", None).await?;
//!     println!("Cast sent: {}", casts[0].hash);
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

// Re-export main types
pub use client::FarcasterClient;
pub use config::FarcasterConfig;
pub use error::{FarcasterError, Result};
pub use types::{
    Cast, CastEmbed, CastId, CastParent, CastStats, EmbedType, FarcasterEventType,
    FarcasterMessageType, FidRequest, Profile,
};

#[cfg(feature = "native")]
pub use service::FarcasterService;

/// Create a Farcaster client from environment variables.
///
/// # Errors
///
/// Returns an error if required environment variables are not set.
pub fn create_client_from_env() -> Result<FarcasterClient> {
    let config = FarcasterConfig::from_env()?;
    FarcasterClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "farcaster";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Farcaster integration for elizaOS - sending and receiving casts via Neynar API";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Service name for registration
pub const FARCASTER_SERVICE_NAME: &str = "farcaster";
/// Source identifier for messages
pub const FARCASTER_SOURCE: &str = "farcaster";

/// Default configuration constants
pub mod defaults {
    /// Default maximum cast length
    pub const MAX_CAST_LENGTH: usize = 320;
    /// Default polling interval in seconds
    pub const POLL_INTERVAL: u64 = 120;
    /// Default minimum cast interval in minutes
    pub const CAST_INTERVAL_MIN: u64 = 90;
    /// Default maximum cast interval in minutes
    pub const CAST_INTERVAL_MAX: u64 = 180;
    /// Default cast cache TTL in milliseconds
    pub const CAST_CACHE_TTL: u64 = 1000 * 30 * 60;
    /// Default cast cache size
    pub const CAST_CACHE_SIZE: usize = 9000;
}
