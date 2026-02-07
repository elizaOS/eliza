//! Character evolution and self-modification plugin for elizaOS agents (Rust).
//!
//! Provides:
//! - Character modification types and validation
//! - Evolution suggestion tracking
//! - Safety validation (XSS prevention, length limits, confidence thresholds)
//! - In-memory personality service with cooldown management

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// In-memory service for character modification tracking and validation.
pub mod service;
/// Type definitions for modifications, suggestions, and configuration.
pub mod types;

pub use service::*;
pub use types::*;

/// Plugin metadata.
pub const PLUGIN_NAME: &str = "personality";
/// Plugin version.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Plugin description.
pub const PLUGIN_DESCRIPTION: &str =
    "Character evolution and self-modification for elizaOS agents";

/// Plugin metadata struct.
pub struct Plugin {
    /// Plugin name.
    pub name: String,
    /// Plugin description.
    pub description: String,
    /// Plugin version.
    pub version: String,
}

/// Returns the plugin metadata.
pub fn plugin() -> Plugin {
    Plugin {
        name: PLUGIN_NAME.to_string(),
        description: PLUGIN_DESCRIPTION.to_string(),
        version: PLUGIN_VERSION.to_string(),
    }
}
