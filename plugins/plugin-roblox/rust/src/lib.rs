//! Roblox integration for elizaOS.
//!
//! This crate provides:
//! - A [`RobloxClient`] for calling Roblox Open Cloud APIs.
//! - Configuration via [`RobloxConfig`], including a convenience constructor
//!   [`create_client_from_env`] for local development and deployment.
//!
//! ## Feature flags
//! - `native` (default): Enables Tokio-based services/actions/providers.
//! - `wasm`: Enables WASM bindings.
#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Roblox Open Cloud API client.
pub mod client;
/// Configuration and environment-variable loading for the Roblox client.
pub mod config;
/// Error types and result alias for this crate.
pub mod error;
/// Data types used by the client and services.
pub mod types;

/// Primary HTTP client for interacting with Roblox Open Cloud APIs.
pub use client::RobloxClient;
/// Configuration for connecting to Roblox Open Cloud APIs.
pub use config::RobloxConfig;
/// Common result type returned by this crate.
pub use error::{Result, RobloxError};

#[cfg(feature = "native")]
/// Native (Tokio) service integration.
pub mod service;

#[cfg(feature = "native")]
/// Native (Tokio) actions exposed by the plugin.
pub mod actions;

#[cfg(feature = "native")]
/// Native (Tokio) runtime providers for the plugin.
pub mod providers;

#[cfg(feature = "wasm")]
/// WASM bindings and helpers.
pub mod wasm;

/// Create a [`RobloxClient`] using environment variables.
///
/// This loads variables from the current process environment and (when present)
/// a local `.env` file via `dotenvy`.
///
/// Required variables:
/// - `ROBLOX_API_KEY`
/// - `ROBLOX_UNIVERSE_ID`
///
/// Optional variables:
/// - `ROBLOX_PLACE_ID`
/// - `ROBLOX_WEBHOOK_SECRET`
/// - `ROBLOX_MESSAGING_TOPIC` (defaults to [`defaults::MESSAGING_TOPIC`])
/// - `ROBLOX_POLL_INTERVAL` (defaults to [`defaults::POLL_INTERVAL`])
/// - `ROBLOX_DRY_RUN` (`true`/`false`, defaults to `false`)
pub fn create_client_from_env() -> Result<RobloxClient> {
    let config = RobloxConfig::from_env()?;
    RobloxClient::new(config)
}

/// Stable plugin identifier used by elizaOS registries.
pub const PLUGIN_NAME: &str = "roblox";
/// Human-readable description of this plugin.
pub const PLUGIN_DESCRIPTION: &str =
    "Roblox integration for elizaOS - game communication via Open Cloud API";
/// Plugin version, sourced from the crate version.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Service name used when registering the Roblox integration.
pub const ROBLOX_SERVICE_NAME: &str = "roblox";
/// Event/source identifier used in logs and message metadata.
pub const ROBLOX_SOURCE: &str = "roblox";

/// Default values for optional configuration fields.
pub mod defaults {
    /// Default Roblox MessagingService topic used for agent/game communication.
    pub const MESSAGING_TOPIC: &str = "eliza-agent";
    /// Default polling interval (in seconds) used by native services.
    pub const POLL_INTERVAL: u64 = 30;
}
