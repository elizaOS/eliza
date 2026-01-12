use async_trait::async_trait;

use super::{N8nProvider, ProviderContext, ProviderResult};

/// Provider that returns information about plugin creation capabilities.
pub struct PluginCreationCapabilitiesProvider;

impl PluginCreationCapabilitiesProvider {
    /// Creates a new instance of the plugin creation capabilities provider.
    pub fn new() -> Self {
        Self
    }
}

impl Default for PluginCreationCapabilitiesProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nProvider for PluginCreationCapabilitiesProvider {
    fn name(&self) -> &'static str {
        "plugin_creation_capabilities"
    }

    fn description(&self) -> &'static str {
        "Provides information about plugin creation capabilities"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let has_api_key = context
            .state
            .get("hasApiKey")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !has_api_key {
            return ProviderResult {
                text: "Plugin creation is available but requires ANTHROPIC_API_KEY".to_string(),
                data: Some(serde_json::json!({
                    "serviceAvailable": true,
                    "aiEnabled": false,
                })),
            };
        }

        ProviderResult {
            text: "Plugin creation service is operational".to_string(),
            data: Some(serde_json::json!({
                "serviceAvailable": true,
                "aiEnabled": true,
                "supportedComponents": ["actions", "providers", "services", "evaluators"],
                "maxIterations": 5,
            })),
        }
    }
}
