//! elizaOS Telegram Plugin
//!
//! This crate provides Telegram integration for elizaOS agents.
//!
//! # Features
//!
//! - `native`: Full Telegram client support using teloxide (default)
//!
//! # Example
//!
//! ```no_run
//! use elizaos_plugin_telegram::{TelegramConfig, TelegramService};
//!
//! #[tokio::main]
//! async fn main() {
//!     let config = TelegramConfig::from_env().expect("Missing Telegram credentials");
//!     let mut service = TelegramService::new(config);
//!     service.start().await.expect("Failed to start Telegram service");
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "native")]
pub mod service;

#[cfg(feature = "native")]
pub mod actions;

#[cfg(feature = "native")]
pub mod providers;

// Re-exports for convenience
pub use config::TelegramConfig;
pub use error::{Result, TelegramError};
pub use types::*;

#[cfg(feature = "native")]
pub use service::TelegramService;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "telegram";
/// Plugin version matching Cargo.toml
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str = "Telegram integration for elizaOS agents";

/// Create the Telegram plugin instance
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
