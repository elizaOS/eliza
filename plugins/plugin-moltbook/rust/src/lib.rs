#![allow(missing_docs)]

pub mod actions;
pub mod constants;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

pub struct MoltbookPlugin {
    pub name: &'static str,
    pub description: &'static str,
}

impl MoltbookPlugin {
    pub const fn new() -> Self {
        Self {
            name: "@elizaos/plugin-moltbook-rs",
            description: "Moltbook social plugin for Eliza agents. Enables posting, browsing, and commenting on Moltbook - Reddit for AI agents.",
        }
    }

    pub fn actions() -> Vec<&'static str> {
        vec![
            "MOLTBOOK_POST",
            "MOLTBOOK_BROWSE",
            "MOLTBOOK_COMMENT",
            "MOLTBOOK_READ",
            "MOLTBOOK_SUBMOLTS",
        ]
    }

    pub fn providers() -> Vec<&'static str> {
        vec!["MOLTBOOK_STATE"]
    }
}

impl Default for MoltbookPlugin {
    fn default() -> Self {
        Self::new()
    }
}

pub static PLUGIN: MoltbookPlugin = MoltbookPlugin::new();
