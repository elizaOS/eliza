//! Plugin Manager actions — LOAD_PLUGIN, UNLOAD_PLUGIN, LIST_PLUGINS.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::actions::Action;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::service::PluginManagerService;
use super::types::*;

// ============================================================================
// LOAD_PLUGIN
// ============================================================================

/// Action to load/enable a registered plugin.
pub struct LoadPluginAction {
    service: Arc<PluginManagerService>,
}

impl LoadPluginAction {
    /// Create a new LoadPluginAction.
    pub fn new(service: Arc<PluginManagerService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for LoadPluginAction {
    fn name(&self) -> &'static str {
        "LOAD_PLUGIN"
    }

    fn similes(&self) -> &[&'static str] {
        &["ENABLE_PLUGIN", "ACTIVATE_PLUGIN", "START_PLUGIN"]
    }

    fn description(&self) -> &'static str {
        "Load and activate a registered plugin"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let plugin_id = params
            .get("pluginId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing 'pluginId' parameter".to_string())
            })?;

        let force = params
            .get("force")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let load_params = LoadPluginParams {
            plugin_id: plugin_id.to_string(),
            force,
        };

        match self.service.load_plugin(&load_params).await {
            Ok(plugin) => Ok(ActionResult::success(format!(
                "Plugin '{}' loaded successfully",
                plugin.name
            ))
            .with_data("pluginId", plugin.id)
            .with_data("status", serde_json::json!(plugin.status))
            .with_data("actionName", "LOAD_PLUGIN")),
            Err(e) => Ok(ActionResult::error(format!(
                "Failed to load plugin: {}",
                e
            ))),
        }
    }
}

// ============================================================================
// UNLOAD_PLUGIN
// ============================================================================

/// Action to unload/disable a plugin.
pub struct UnloadPluginAction {
    service: Arc<PluginManagerService>,
}

impl UnloadPluginAction {
    /// Create a new UnloadPluginAction.
    pub fn new(service: Arc<PluginManagerService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for UnloadPluginAction {
    fn name(&self) -> &'static str {
        "UNLOAD_PLUGIN"
    }

    fn similes(&self) -> &[&'static str] {
        &["DISABLE_PLUGIN", "DEACTIVATE_PLUGIN", "STOP_PLUGIN"]
    }

    fn description(&self) -> &'static str {
        "Unload and deactivate a plugin"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let plugin_id = params
            .get("pluginId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing 'pluginId' parameter".to_string())
            })?;

        let force = params
            .get("force")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let unload_params = UnloadPluginParams {
            plugin_id: plugin_id.to_string(),
            force,
        };

        match self.service.unload_plugin(&unload_params).await {
            Ok(plugin) => Ok(ActionResult::success(format!(
                "Plugin '{}' unloaded",
                plugin.name
            ))
            .with_data("pluginId", plugin.id)
            .with_data("actionName", "UNLOAD_PLUGIN")),
            Err(e) => Ok(ActionResult::error(format!(
                "Failed to unload plugin: {}",
                e
            ))),
        }
    }
}

// ============================================================================
// LIST_PLUGINS
// ============================================================================

/// Action to list all managed plugins and their status.
pub struct ListPluginsAction {
    service: Arc<PluginManagerService>,
}

impl ListPluginsAction {
    /// Create a new ListPluginsAction.
    pub fn new(service: Arc<PluginManagerService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for ListPluginsAction {
    fn name(&self) -> &'static str {
        "LIST_PLUGINS"
    }

    fn similes(&self) -> &[&'static str] {
        &["SHOW_PLUGINS", "PLUGIN_STATUS", "PLUGINS"]
    }

    fn description(&self) -> &'static str {
        "List all managed plugins and their current status"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        _state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let plugins = self.service.get_all_plugins().await;

        if plugins.is_empty() {
            return Ok(ActionResult::success("No plugins registered".to_string())
                .with_data("pluginCount", serde_json::json!(0))
                .with_data("actionName", "LIST_PLUGINS"));
        }

        let plugin_list: Vec<serde_json::Value> = plugins
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "name": p.name,
                    "status": p.status,
                    "version": p.version,
                    "error": p.error,
                })
            })
            .collect();

        let text = plugins
            .iter()
            .map(|p| {
                format!(
                    "- {} ({:?}){}",
                    p.name,
                    p.status,
                    p.version
                        .as_ref()
                        .map(|v| format!(" v{}", v))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        Ok(ActionResult::success(format!(
            "Plugins ({}):\n{}",
            plugins.len(),
            text
        ))
        .with_data("plugins", serde_json::json!(plugin_list))
        .with_data("pluginCount", serde_json::json!(plugins.len()))
        .with_data("actionName", "LIST_PLUGINS"))
    }
}
