//! elizaOS Goals Plugin
//!
//! This crate provides goal management functionality for elizaOS agents.
//!
//! # Features
//!
//! - `native`: Full async support with tokio (default)
//!
//! # Example
//!
//! ```no_run
//! use elizaos_plugin_goals::{GoalService, CreateGoalParams, GoalOwnerType};
//!
//! #[tokio::main]
//! async fn main() {
//!     // Goal service would be created with a database connection
//!     // let service = GoalService::new(db);
//!     // let goal = service.create_goal(params).await.unwrap();
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod error;
pub mod types;

#[cfg(feature = "native")]
pub mod service;

#[cfg(feature = "native")]
pub mod actions;

#[cfg(feature = "native")]
pub mod providers;

// Re-exports for convenience
pub use error::{GoalError, Result};
pub use types::*;

#[cfg(feature = "native")]
pub use service::GoalService;

/// Plugin metadata
pub const PLUGIN_NAME: &str = "goals";
/// Plugin version matching Cargo.toml
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str = "Goal management for elizaOS agents";

/// Create the Goals plugin instance
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
