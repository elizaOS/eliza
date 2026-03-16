//! Goal management plugin for elizaOS agents.
//!
//! This plugin provides functionality for creating, tracking, and managing goals
//! for AI agents. Goals can be assigned to either agents or entities and support
//! metadata, tags, and completion tracking.
//!
//! # Features
//!
//! - Create and manage goals with rich metadata
//! - Track goal completion status
//! - Filter goals by owner, status, and tags
//! - In-memory storage (native feature)
//!
//! # Example
//!
//! ```rust
//! use elizaos_plugin_goals::{plugin, CreateGoalParams, GoalOwnerType};
//!
//! let p = plugin();
//! println!("Plugin: {} v{}", p.name, p.version);
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Error types and result aliases for goal operations.
pub mod error;
/// Type definitions for goals, filters, and related structures.
pub mod types;

#[cfg(feature = "native")]
/// Service layer for goal persistence and business logic.
pub mod service;

#[cfg(feature = "native")]
/// Goal-related actions that can be performed by agents.
pub mod actions;

#[cfg(feature = "native")]
/// Providers for goal data access.
pub mod providers;

// Re-exports for convenience
pub use error::{GoalError, Result};
pub use types::*;

#[cfg(feature = "native")]
pub use service::{GoalDataServiceWrapper, GoalService};

/// The name identifier for this plugin.
pub const PLUGIN_NAME: &str = "goals";
/// The version of this plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// A human-readable description of this plugin's purpose.
pub const PLUGIN_DESCRIPTION: &str = "Goal management for elizaOS agents";

/// Creates a runtime-native elizaOS plugin (`elizaos::Plugin`).
///
/// This is the interface expected by the Rust AgentRuntime plugin system.
pub fn eliza_plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(PLUGIN_NAME, PLUGIN_DESCRIPTION)
}

/// Creates a new instance of the goals plugin with default configuration.
///
/// # Returns
///
/// A `Plugin` instance with the plugin name, version, and description.
pub fn plugin() -> Plugin {
    Plugin {
        name: PLUGIN_NAME.to_string(),
        description: PLUGIN_DESCRIPTION.to_string(),
        version: PLUGIN_VERSION.to_string(),
    }
}

/// Plugin metadata and configuration.
#[derive(Debug, Clone)]
pub struct Plugin {
    /// The unique name identifier for this plugin.
    pub name: String,
    /// A human-readable description of the plugin's functionality.
    pub description: String,
    /// The semantic version of the plugin.
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
