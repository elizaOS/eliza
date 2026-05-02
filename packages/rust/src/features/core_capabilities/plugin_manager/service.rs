//! PluginManagerService — manages plugin lifecycle (load, unload, status).

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::*;

/// In-memory plugin manager service.
pub struct PluginManagerService {
    /// Plugin states keyed by plugin ID.
    plugins: Arc<RwLock<HashMap<String, PluginState>>>,
    /// Component registrations.
    registrations: Arc<RwLock<Vec<ComponentRegistration>>>,
    /// Configuration.
    config: PluginManagerConfig,
}

impl PluginManagerService {
    /// Create a new PluginManagerService.
    pub fn new(config: PluginManagerConfig) -> Self {
        Self {
            plugins: Arc::new(RwLock::new(HashMap::new())),
            registrations: Arc::new(RwLock::new(Vec::new())),
            config,
        }
    }

    /// Register a plugin.
    pub async fn register_plugin(
        &self,
        id: &str,
        name: &str,
        version: Option<&str>,
    ) -> anyhow::Result<PluginState> {
        let now = chrono::Utc::now().timestamp_millis();
        let state = PluginState {
            id: id.to_string(),
            name: name.to_string(),
            status: PluginStatus::Ready,
            error: None,
            created_at: now,
            loaded_at: None,
            unloaded_at: None,
            version: version.map(String::from),
            components: Some(PluginComponents::default()),
        };

        self.plugins
            .write()
            .await
            .insert(id.to_string(), state.clone());

        Ok(state)
    }

    /// Load a plugin.
    pub async fn load_plugin(&self, params: &LoadPluginParams) -> anyhow::Result<PluginState> {
        let mut plugins = self.plugins.write().await;
        let plugin = plugins
            .get_mut(&params.plugin_id)
            .ok_or_else(|| anyhow::anyhow!("Plugin '{}' not registered", params.plugin_id))?;

        if plugin.status == PluginStatus::Loaded && !params.force {
            return Ok(plugin.clone());
        }

        let now = chrono::Utc::now().timestamp_millis();
        plugin.status = PluginStatus::Loaded;
        plugin.loaded_at = Some(now);
        plugin.error = None;

        Ok(plugin.clone())
    }

    /// Unload a plugin.
    pub async fn unload_plugin(&self, params: &UnloadPluginParams) -> anyhow::Result<PluginState> {
        let mut plugins = self.plugins.write().await;
        let plugin = plugins
            .get_mut(&params.plugin_id)
            .ok_or_else(|| anyhow::anyhow!("Plugin '{}' not found", params.plugin_id))?;

        let now = chrono::Utc::now().timestamp_millis();
        plugin.status = PluginStatus::Unloaded;
        plugin.unloaded_at = Some(now);

        // Remove component registrations
        let plugin_id = params.plugin_id.clone();
        self.registrations
            .write()
            .await
            .retain(|r| r.plugin_id != plugin_id);

        Ok(plugin.clone())
    }

    /// Get plugin state.
    pub async fn get_plugin(&self, id: &str) -> Option<PluginState> {
        self.plugins.read().await.get(id).cloned()
    }

    /// Get all plugins.
    pub async fn get_all_plugins(&self) -> Vec<PluginState> {
        self.plugins.read().await.values().cloned().collect()
    }

    /// Get loaded plugins.
    pub async fn get_loaded_plugins(&self) -> Vec<PluginState> {
        self.plugins
            .read()
            .await
            .values()
            .filter(|p| p.status == PluginStatus::Loaded)
            .cloned()
            .collect()
    }

    /// Register a component for a plugin.
    pub async fn register_component(
        &self,
        plugin_id: &str,
        component_type: ComponentType,
        component_name: &str,
    ) -> anyhow::Result<()> {
        let now = chrono::Utc::now().timestamp_millis();

        // Update plugin components
        let mut plugins = self.plugins.write().await;
        if let Some(plugin) = plugins.get_mut(plugin_id) {
            let components = plugin
                .components
                .get_or_insert_with(PluginComponents::default);
            match component_type {
                ComponentType::Action => {
                    components.actions.insert(component_name.to_string());
                }
                ComponentType::Provider => {
                    components.providers.insert(component_name.to_string());
                }
                ComponentType::Evaluator => {
                    components.evaluators.insert(component_name.to_string());
                }
                ComponentType::Service => {
                    components.services.insert(component_name.to_string());
                }
                ComponentType::EventHandler => {
                    components
                        .event_handlers
                        .entry(component_name.to_string())
                        .or_insert_with(Vec::new);
                }
            }
        }

        // Add registration record
        self.registrations
            .write()
            .await
            .push(ComponentRegistration {
                plugin_id: plugin_id.to_string(),
                component_type,
                component_name: component_name.to_string(),
                timestamp: now,
            });

        Ok(())
    }

    /// Mark a plugin as errored.
    pub async fn set_plugin_error(&self, id: &str, error: &str) -> anyhow::Result<()> {
        let mut plugins = self.plugins.write().await;
        if let Some(plugin) = plugins.get_mut(id) {
            plugin.status = PluginStatus::Error;
            plugin.error = Some(error.to_string());
        }
        Ok(())
    }

    /// Get configuration.
    pub fn config(&self) -> &PluginManagerConfig {
        &self.config
    }
}

impl Default for PluginManagerService {
    fn default() -> Self {
        Self::new(PluginManagerConfig::default())
    }
}
