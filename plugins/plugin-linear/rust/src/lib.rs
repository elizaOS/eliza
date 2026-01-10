//! ElizaOS Linear Plugin (Rust)
//!
//! A comprehensive Linear integration plugin for ElizaOS that enables
//! issue tracking, project management, and team collaboration.

pub mod actions;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

pub use error::{LinearError, Result};
pub use service::LinearService;
pub use types::*;

// Re-export action and provider functions
pub use actions::{
    create_issue, get_issue, update_issue, delete_issue, search_issues,
    create_comment, list_teams, list_projects, get_activity, clear_activity,
};
pub use providers::{
    get_issues_context, get_teams_context, get_projects_context, get_activity_context,
};

/// Plugin definition for ElizaOS
pub struct LinearPlugin {
    pub name: &'static str,
    pub description: &'static str,
}

impl LinearPlugin {
    pub const fn new() -> Self {
        Self {
            name: "@elizaos/plugin-linear-rs",
            description: "Plugin for integrating with Linear issue tracking system",
        }
    }

    /// Get all actions provided by this plugin
    pub fn actions() -> Vec<&'static str> {
        vec![
            "CREATE_LINEAR_ISSUE",
            "GET_LINEAR_ISSUE",
            "UPDATE_LINEAR_ISSUE",
            "DELETE_LINEAR_ISSUE",
            "SEARCH_LINEAR_ISSUES",
            "CREATE_LINEAR_COMMENT",
            "LIST_LINEAR_TEAMS",
            "LIST_LINEAR_PROJECTS",
            "GET_LINEAR_ACTIVITY",
            "CLEAR_LINEAR_ACTIVITY",
        ]
    }

    /// Get all providers provided by this plugin
    pub fn providers() -> Vec<&'static str> {
        vec![
            "LINEAR_ISSUES",
            "LINEAR_TEAMS",
            "LINEAR_PROJECTS",
            "LINEAR_ACTIVITY",
        ]
    }
}

impl Default for LinearPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// The main plugin instance
pub static PLUGIN: LinearPlugin = LinearPlugin::new();

