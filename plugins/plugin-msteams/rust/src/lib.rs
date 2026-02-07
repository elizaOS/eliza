//! Microsoft Teams integration plugin for elizaOS.
//!
//! This crate provides:
//! - MS Teams Bot Framework integration
//! - Proactive messaging
//! - Adaptive Cards support
//! - Polls
//! - Graph API integration for user/file operations
//!
//! # Features
//!
//! - `native` (default): Enables the full service implementation with Tokio runtime

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Configuration types and helpers for the MS Teams plugin.
pub mod config;
/// Error types returned by the MS Teams plugin.
pub mod error;
/// Serializable types used for events and payloads.
pub mod types;

#[cfg(feature = "native")]
/// MS Teams Bot Framework client implementation.
pub mod client;

#[cfg(feature = "native")]
/// Native MS Teams service implementation (requires the `native` feature).
pub mod service;

#[cfg(feature = "native")]
/// Action interfaces and built-in actions for the native MS Teams service.
pub mod actions;

#[cfg(feature = "native")]
/// Provider interfaces and built-in providers for the native MS Teams service.
pub mod providers;

pub use config::MSTeamsConfig;
pub use error::{MSTeamsError, Result};
pub use types::*;

#[cfg(feature = "native")]
pub use client::MSTeamsClient;

#[cfg(feature = "native")]
pub use service::MSTeamsService;

/// Canonical plugin name.
pub const PLUGIN_NAME: &str = "msteams";
/// Plugin version (from Cargo package metadata).
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Human-friendly plugin description.
pub const PLUGIN_DESCRIPTION: &str = "Microsoft Teams integration for elizaOS agents via Bot Framework";

/// Returns the plugin metadata used by the elizaOS plugin system.
pub fn plugin() -> Plugin {
    Plugin {
        name: PLUGIN_NAME.to_string(),
        description: PLUGIN_DESCRIPTION.to_string(),
        version: PLUGIN_VERSION.to_string(),
    }
}

/// Plugin metadata (name, description, and version).
#[derive(Debug, Clone)]
pub struct Plugin {
    /// The plugin identifier (e.g. `"msteams"`).
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

    #[test]
    fn test_plugin_name() {
        assert_eq!(PLUGIN_NAME, "msteams");
    }
}
