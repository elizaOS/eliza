//! Plugin Manager capability — runtime plugin lifecycle management.
//!
//! Ports the TypeScript `plugin-plugin-manager` module, providing:
//! - Plugin status, components, metadata, and operation result types
//! - PluginManagerService for plugin lifecycle
//! - LOAD_PLUGIN, UNLOAD_PLUGIN, LIST_PLUGINS actions
//! - PLUGIN_MANAGER provider

pub mod actions;
pub mod providers;
pub mod service;
pub mod types;

pub use actions::{ListPluginsAction, LoadPluginAction, UnloadPluginAction};
pub use providers::PluginManagerProvider;
pub use service::PluginManagerService;
pub use types::*;
