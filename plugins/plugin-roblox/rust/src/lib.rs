//! Roblox plugin for elizaOS.
//!
//! This crate provides Roblox integration for elizaOS, enabling game communication
//! via the Roblox Open Cloud API. It supports messaging, game state synchronization,
//! and agent interactions within Roblox experiences.

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

pub use client::RobloxClient;
pub use config::RobloxConfig;
pub use error::{Result, RobloxError};

#[cfg(feature = "native")]
pub mod service;

#[cfg(feature = "native")]
pub mod actions;

#[cfg(feature = "native")]
pub mod providers;

#[cfg(feature = "wasm")]
pub mod wasm;

/// Creates a new Roblox client using configuration from environment variables.
///
/// This is a convenience function that loads the configuration from environment
/// variables and creates a new [`RobloxClient`] instance.
///
/// # Errors
///
/// Returns an error if required environment variables are missing or if client
/// creation fails.
pub fn create_client_from_env() -> Result<RobloxClient> {
    let config = RobloxConfig::from_env()?;
    RobloxClient::new(config)
}

/// The name identifier for the Roblox plugin.
pub const PLUGIN_NAME: &str = "roblox";

/// Human-readable description of the Roblox plugin.
pub const PLUGIN_DESCRIPTION: &str =
    "Roblox integration for elizaOS - game communication via Open Cloud API";

/// The version of the Roblox plugin, derived from the crate version.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The service name used to identify the Roblox service in the runtime.
pub const ROBLOX_SERVICE_NAME: &str = "roblox";

/// The source identifier for messages originating from Roblox.
pub const ROBLOX_SOURCE: &str = "roblox";

/// Default configuration values for the Roblox plugin.
pub mod defaults {
    /// The default messaging topic used for agent communication.
    pub const MESSAGING_TOPIC: &str = "eliza-agent";

    /// The default polling interval in seconds for checking new messages.
    pub const POLL_INTERVAL: u64 = 30;
}







