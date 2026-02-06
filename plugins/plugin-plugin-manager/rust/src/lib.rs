#![allow(missing_docs)]

pub mod actions;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

pub struct PluginManagerPlugin {
    pub name: &'static str,
    pub description: &'static str,
}

impl PluginManagerPlugin {
    pub const fn new() -> Self {
        Self {
            name: "@elizaos/plugin-plugin-manager-rs",
            description: "Manages dynamic loading and unloading of plugins at runtime, with registry integration and configuration status checking",
        }
    }

    pub fn actions() -> Vec<&'static str> {
        vec![
            "LOAD_PLUGIN",
            "UNLOAD_PLUGIN",
            "INSTALL_PLUGIN_FROM_REGISTRY",
            "SEARCH_PLUGINS",
            "GET_PLUGIN_DETAILS",
            "CLONE_PLUGIN",
            "PUBLISH_PLUGIN",
        ]
    }

    pub fn providers() -> Vec<&'static str> {
        vec![
            "PLUGIN_STATE",
            "PLUGIN_CONFIGURATION_STATUS",
            "REGISTRY_PLUGINS",
        ]
    }
}

impl Default for PluginManagerPlugin {
    fn default() -> Self {
        Self::new()
    }
}

pub static PLUGIN: PluginManagerPlugin = PluginManagerPlugin::new();
