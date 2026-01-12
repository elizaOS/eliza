use async_trait::async_trait;

use super::{N8nProvider, ProviderContext, ProviderResult};

/// Provider that returns information about all created plugins in the session.
pub struct PluginRegistryProvider;

impl PluginRegistryProvider {
    /// Creates a new instance of the plugin registry provider.
    pub fn new() -> Self {
        Self
    }
}

impl Default for PluginRegistryProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nProvider for PluginRegistryProvider {
    fn name(&self) -> &'static str {
        "plugin_registry"
    }

    fn description(&self) -> &'static str {
        "Provides information about all created plugins in the session"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let registry = context
            .state
            .get("pluginRegistry")
            .and_then(|r| r.as_array());

        match registry {
            Some(plugins) if !plugins.is_empty() => {
                let plugin_list: Vec<String> = plugins
                    .iter()
                    .filter_map(|p| p.get("name").and_then(|n| n.as_str()))
                    .map(String::from)
                    .collect();

                ProviderResult {
                    text: format!(
                        "Created plugins in this session: {}",
                        plugin_list.join(", ")
                    ),
                    data: Some(serde_json::json!({
                        "plugins": plugin_list,
                        "count": plugin_list.len(),
                    })),
                }
            }
            _ => ProviderResult {
                text: "No plugins have been created in this session".to_string(),
                data: Some(serde_json::json!({
                    "plugins": [],
                    "count": 0,
                })),
            },
        }
    }
}
