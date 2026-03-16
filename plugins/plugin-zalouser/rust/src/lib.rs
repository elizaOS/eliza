//! Zalo User integration plugin for elizaOS.
//!
//! This crate provides Zalo personal account integration via zca-cli:
//! - QR code login flow
//! - DMs and group messages
//! - Multi-profile support
//! - Agent tools exposure

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Configuration types and helpers.
pub mod config;
/// ZCA CLI client wrapper.
pub mod client;
/// Error types.
pub mod error;
/// Serializable types for events and payloads.
pub mod types;

#[cfg(feature = "native")]
/// Native service implementation (requires `native` feature).
pub mod service;

#[cfg(feature = "native")]
/// Action interfaces and built-in actions.
pub mod actions;

#[cfg(feature = "native")]
/// Provider interfaces and built-in providers.
pub mod providers;

pub use config::ZaloUserConfig;
pub use error::{Result, ZaloUserError};
pub use types::*;

#[cfg(feature = "native")]
pub use service::ZaloUserService;

/// Canonical plugin name.
pub const PLUGIN_NAME: &str = "zalouser";
/// Plugin version.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Plugin description.
pub const PLUGIN_DESCRIPTION: &str = "Zalo personal account integration for elizaOS agents via zca-cli";

/// Plugin metadata.
#[derive(Debug, Clone)]
pub struct Plugin {
    /// Plugin identifier.
    pub name: String,
    /// Plugin description.
    pub description: String,
    /// Plugin version.
    pub version: String,
}

/// Get the plugin metadata.
pub fn plugin() -> Plugin {
    Plugin {
        name: PLUGIN_NAME.to_string(),
        description: PLUGIN_DESCRIPTION.to_string(),
        version: PLUGIN_VERSION.to_string(),
    }
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
