//! Mattermost integration plugin for elizaOS.
//!
//! This crate contains:
//! - Shared data types used by the Mattermost plugin
//! - Configuration and error types
//! - A native service implementation when the `native` feature is enabled

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Configuration types and helpers for the Mattermost plugin.
pub mod config;
/// Error types returned by the Mattermost plugin.
pub mod error;
/// Serializable types used for events and payloads.
pub mod types;
/// HTTP client for Mattermost REST API.
pub mod client;

#[cfg(feature = "native")]
/// Native Mattermost service implementation (requires the `native` feature).
pub mod service;

#[cfg(feature = "native")]
/// Action interfaces and built-in actions for the native Mattermost service.
pub mod actions;

#[cfg(feature = "native")]
/// Provider interfaces and built-in providers for the native Mattermost service.
pub mod providers;

pub use config::MattermostConfig;
pub use error::{MattermostError, Result};
pub use types::*;

#[cfg(feature = "native")]
pub use service::MattermostService;

/// Canonical plugin name.
pub const PLUGIN_NAME: &str = "mattermost";
/// Plugin version (from Cargo package metadata).
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Human-friendly plugin description.
pub const PLUGIN_DESCRIPTION: &str = "Mattermost integration for elizaOS agents";

/// Returns the plugin metadata used by the elizaOS plugin system.
pub fn plugin() -> Plugin {
    Plugin {
        name: PLUGIN_NAME.to_string(),
        description: PLUGIN_DESCRIPTION.to_string(),
        version: PLUGIN_VERSION.to_string(),
    }
}

#[derive(Debug, Clone)]
/// Plugin metadata (name, description, and version).
pub struct Plugin {
    /// The plugin identifier (e.g. `"mattermost"`).
    pub name: String,
    /// A human-friendly description of the plugin.
    pub description: String,
    /// The plugin version string.
    pub version: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_creation() {
        let p = plugin();
        assert_eq!(p.name, PLUGIN_NAME);
        assert!(!p.description.is_empty());
    }
}
