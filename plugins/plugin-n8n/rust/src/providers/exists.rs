use async_trait::async_trait;

use super::{N8nProvider, ProviderContext, ProviderResult};

/// Provider that checks if a specific plugin has already been created.
pub struct PluginExistsProvider;

impl PluginExistsProvider {
    /// Creates a new instance of the plugin exists provider.
    pub fn new() -> Self {
        Self
    }
}

impl Default for PluginExistsProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nProvider for PluginExistsProvider {
    fn name(&self) -> &'static str {
        "plugin_exists"
    }

    fn description(&self) -> &'static str {
        "Checks if a specific plugin has already been created"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let plugin_name = context
            .state
            .get("checkPluginName")
            .and_then(|n| n.as_str());
        let registry = context
            .state
            .get("pluginRegistry")
            .and_then(|r| r.as_array());

        match (plugin_name, registry) {
            (Some(name), Some(plugins)) => {
                let exists = plugins
                    .iter()
                    .any(|p| p.get("name").and_then(|n| n.as_str()) == Some(name));

                ProviderResult {
                    text: if exists {
                        format!("Plugin '{}' already exists in the registry", name)
                    } else {
                        format!("Plugin '{}' does not exist in the registry", name)
                    },
                    data: Some(serde_json::json!({
                        "pluginName": name,
                        "exists": exists,
                    })),
                }
            }
            _ => ProviderResult {
                text: "No plugin name specified to check".to_string(),
                data: None,
            },
        }
    }
}

/// TS-parity alias provider (name: `plugin_exists_check`).
pub struct PluginExistsCheckProvider;

impl PluginExistsCheckProvider {
    /// Creates a new instance of the plugin exists check provider.
    pub fn new() -> Self {
        Self
    }
}

impl Default for PluginExistsCheckProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nProvider for PluginExistsCheckProvider {
    fn name(&self) -> &'static str {
        "plugin_exists_check"
    }

    fn description(&self) -> &'static str {
        "Checks if a specific plugin has already been created"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        PluginExistsProvider.get(context).await
    }
}
