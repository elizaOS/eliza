//! elizaOS Instagram Plugin
//!
//! This crate provides Instagram integration for elizaOS agents.
//!
//! # Features
//!
//! - `native`: Full async support with tokio (default)
//!
//! # Example
//!
//! ```no_run
//! use elizaos_plugin_instagram::{InstagramConfig, InstagramService};
//!
//! #[tokio::main]
//! async fn main() {
//!     let config = InstagramConfig::from_env().expect("Missing Instagram credentials");
//!     let mut service = InstagramService::new(config);
//!     service.start().await.expect("Failed to start Instagram service");
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
pub use config::InstagramConfig;
pub use error::{InstagramError, Result};
pub use types::*;

#[cfg(feature = "native")]
pub use service::InstagramService;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "instagram";
/// Plugin version matching Cargo.toml
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str = "Instagram integration for elizaOS agents";

/// Maximum caption length for Instagram posts
pub const MAX_CAPTION_LENGTH: usize = 2200;
/// Maximum DM length
pub const MAX_DM_LENGTH: usize = 1000;
/// Maximum comment length
pub const MAX_COMMENT_LENGTH: usize = 1000;

/// Create the Instagram plugin instance
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
