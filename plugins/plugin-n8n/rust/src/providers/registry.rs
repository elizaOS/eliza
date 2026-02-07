use async_trait::async_trait;

use super::{N8nProvider, ProviderContext, ProviderResult};

/// Provider that returns information about all created plugins in the session,
/// including existence checks (merged from PluginExistsProvider).
pub struct PluginRegistryProvider;

impl PluginRegistryProvider {
    /// Creates a new instance of the plugin registry provider.
    pub fn new() -> Self {
        Self
    }

    /// Checks whether a specific plugin exists in the registry.
    pub fn check_exists(plugins: &[serde_json::Value], name: &str) -> bool {
        plugins
            .iter()
            .any(|p| p.get("name").and_then(|n| n.as_str()) == Some(name))
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
        "n8n_plugin_registry"
    }

    fn description(&self) -> &'static str {
        "Provides information about all created plugins in the session, including existence checks"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let registry = context
            .state
            .get("pluginRegistry")
            .and_then(|r| r.as_array());

        // If a specific plugin name is requested, check existence
        if let Some(check_name) = context
            .state
            .get("checkPluginName")
            .and_then(|n| n.as_str())
        {
            let exists = registry
                .map(|plugins| Self::check_exists(plugins, check_name))
                .unwrap_or(false);

            return ProviderResult {
                text: if exists {
                    format!("Plugin '{}' already exists in the registry", check_name)
                } else {
                    format!("Plugin '{}' does not exist in the registry", check_name)
                },
                data: Some(serde_json::json!({
                    "pluginName": check_name,
                    "exists": exists,
                })),
            };
        }

        // Otherwise return full registry listing
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
