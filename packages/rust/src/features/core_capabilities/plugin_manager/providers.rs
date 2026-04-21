//! Plugin Manager provider — surfaces plugin status in agent context.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::providers::Provider;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::service::PluginManagerService;
use super::types::PluginStatus;

/// Provider that surfaces plugin manager state in agent context.
pub struct PluginManagerProvider {
    service: Arc<PluginManagerService>,
}

impl PluginManagerProvider {
    /// Create a new PluginManagerProvider.
    pub fn new(service: Arc<PluginManagerService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Provider for PluginManagerProvider {
    fn name(&self) -> &'static str {
        "PLUGIN_MANAGER"
    }

    fn description(&self) -> &'static str {
        "Plugin manager status showing loaded, available, and errored plugins"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let all_plugins = self.service.get_all_plugins().await;

        if all_plugins.is_empty() {
            return Ok(
                ProviderResult::new("No plugins registered.").with_value("pluginCount", 0i64)
            );
        }

        let loaded = all_plugins
            .iter()
            .filter(|p| p.status == PluginStatus::Loaded)
            .count();
        let errored = all_plugins
            .iter()
            .filter(|p| p.status == PluginStatus::Error)
            .count();
        let unloaded = all_plugins
            .iter()
            .filter(|p| p.status == PluginStatus::Unloaded)
            .count();

        let mut lines = Vec::new();
        for plugin in &all_plugins {
            let status_icon = match plugin.status {
                PluginStatus::Loaded => "loaded",
                PluginStatus::Ready => "ready",
                PluginStatus::Error => "ERROR",
                PluginStatus::Unloaded => "unloaded",
            };

            let component_summary = plugin
                .components
                .as_ref()
                .map(|c| {
                    format!(
                        " ({}a/{}p/{}e/{}s)",
                        c.actions.len(),
                        c.providers.len(),
                        c.evaluators.len(),
                        c.services.len()
                    )
                })
                .unwrap_or_default();

            let error_suffix = plugin
                .error
                .as_ref()
                .map(|e| format!(" - {}", e))
                .unwrap_or_default();

            lines.push(format!(
                "  - {} [{}]{}{}",
                plugin.name, status_icon, component_summary, error_suffix
            ));
        }

        let text = format!(
            "# Plugin Manager\n\
             Total: {} | Loaded: {} | Errored: {} | Unloaded: {}\n\n\
             {}\n",
            all_plugins.len(),
            loaded,
            errored,
            unloaded,
            lines.join("\n")
        );

        Ok(ProviderResult::new(text)
            .with_value("pluginCount", all_plugins.len() as i64)
            .with_value("loadedPlugins", loaded as i64)
            .with_value("erroredPlugins", errored as i64))
    }
}
