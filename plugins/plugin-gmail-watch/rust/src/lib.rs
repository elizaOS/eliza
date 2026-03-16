//! Gmail Pub/Sub watcher plugin for elizaOS.
//!
//! This crate manages the `gog gmail watch serve` child process that:
//!   1. Receives Google Pub/Sub push notifications for new emails
//!   2. Fetches message content via the Gmail API
//!   3. Forwards structured payloads to the webhooks plugin (`/hooks/gmail`)
//!   4. Auto-renews the Gmail watch periodically
//!
//! Prerequisites:
//!   - gog CLI installed and authorized for the Gmail account
//!   - Google Cloud Pub/Sub topic + subscription configured
//!   - hooks.enabled=true and hooks.gmail.account set in config

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Configuration types and helpers.
pub mod config;
/// Error types returned by the plugin.
pub mod error;

#[cfg(feature = "native")]
/// Native service implementation (requires the `native` feature).
pub mod service;

pub use config::{GmailWatchConfig, ServeConfig};
pub use error::{GmailWatchError, Result};

#[cfg(feature = "native")]
pub use service::GmailWatchService;

/// Canonical plugin name.
pub const PLUGIN_NAME: &str = "gmail-watch";
/// Plugin version (from Cargo package metadata).
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Human-friendly plugin description.
pub const PLUGIN_DESCRIPTION: &str =
    "Gmail Pub/Sub push watcher – spawns gog gmail watch serve";

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
    /// The plugin identifier (e.g. `"gmail-watch"`).
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
        assert_eq!(p.name, "gmail-watch");
        assert!(!p.description.is_empty());
        assert!(!p.version.is_empty());
    }

    #[test]
    fn test_plugin_version() {
        assert_eq!(PLUGIN_VERSION, "2.0.0");
    }

    #[test]
    fn test_plugin_description() {
        assert!(PLUGIN_DESCRIPTION.contains("Gmail"));
    }
}
