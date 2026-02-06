#![allow(missing_docs)]

pub mod actions;
pub mod error;
pub mod providers;
pub mod types;

pub struct MemoryPlugin {
    pub name: &'static str,
    pub description: &'static str,
}

impl MemoryPlugin {
    pub const fn new() -> Self {
        Self {
            name: "@elizaos/plugin-memory-rs",
            description: "Plugin for long-term memory management with remember, recall, and forget capabilities",
        }
    }

    pub fn actions() -> Vec<&'static str> {
        vec!["REMEMBER", "RECALL", "FORGET"]
    }

    pub fn providers() -> Vec<&'static str> {
        vec!["MEMORY_CONTEXT"]
    }
}

impl Default for MemoryPlugin {
    fn default() -> Self {
        Self::new()
    }
}

pub static PLUGIN: MemoryPlugin = MemoryPlugin::new();
