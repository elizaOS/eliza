use async_trait::async_trait;

use super::{N8nProvider, ProviderContext, ProviderResult};

/// Stubbed provider — capabilities are no longer surfaced as a standalone provider.
/// Retained for backwards compatibility; returns a no-op result.
#[deprecated(note = "Capabilities provider has been removed; use PluginRegistryProvider instead")]
pub struct PluginCreationCapabilitiesProvider;

impl PluginCreationCapabilitiesProvider {
    /// Creates a new (stubbed) instance.
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
#[allow(deprecated)]
impl N8nProvider for PluginCreationCapabilitiesProvider {
    fn name(&self) -> &'static str {
        "n8n_plugin_capabilities_stub"
    }

    fn description(&self) -> &'static str {
        "Stubbed — capabilities provider has been removed"
    }

    async fn get(&self, _context: &ProviderContext) -> ProviderResult {
        ProviderResult {
            text: "Plugin creation capabilities provider has been removed.".to_string(),
            data: None,
        }
    }
}
