//! elizaOS Discord Plugin
//!
//! This crate provides Discord integration for elizaOS agents.

#![allow(clippy::result_large_err)]
//!
//! # Features
//!
//! - `native`: Full Discord client support using Serenity (default)
//! - `wasm`: WebAssembly support for browser environments
//!
//! # Example
//!
//! ```no_run
//! use elizaos_plugin_discord::{DiscordConfig, DiscordService};
//!
//! #[tokio::main]
//! async fn main() {
//!     let config = DiscordConfig::from_env().expect("Missing Discord credentials");
//!     let mut service = DiscordService::new(config);
//!     service.start().await.expect("Failed to start Discord service");
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod types;

/// Discord service implementation (native-only).
#[cfg(feature = "native")]
pub mod service;

#[cfg(feature = "native")]
pub mod actions;

#[cfg(feature = "native")]
pub mod providers;

// Re-exports for convenience
pub use config::DiscordConfig;
pub use error::{DiscordError, Result};
pub use types::*;

#[cfg(feature = "native")]
pub use service::DiscordService;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "discord";
/// Plugin version matching Cargo.toml
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str = "Discord integration for elizaOS agents";

/// Create the Discord plugin instance
pub fn plugin() -> Plugin {
    Plugin {
        name: PLUGIN_NAME.to_string(),
        description: PLUGIN_DESCRIPTION.to_string(),
        version: PLUGIN_VERSION.to_string(),
    }
}

/// Plugin metadata structure
#[derive(Debug, Clone)]
pub struct Plugin {
    /// Plugin name
    pub name: String,
    /// Plugin description
    pub description: String,
    /// Plugin version
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
