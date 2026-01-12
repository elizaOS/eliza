#![allow(missing_docs)]

pub mod actions;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

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

pub static PLUGIN: LinearPlugin = LinearPlugin::new();
