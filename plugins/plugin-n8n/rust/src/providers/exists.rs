use async_trait::async_trait;

use super::registry::PluginRegistryProvider;
use super::{N8nProvider, ProviderContext, ProviderResult};

/// Provider that checks if a specific plugin has already been created.
/// Delegates to `PluginRegistryProvider` for the actual lookup.
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
        "n8n_plugin_registry"
    }

    fn description(&self) -> &'static str {
        "Delegates to PluginRegistryProvider for plugin existence checks"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        // Delegate entirely to the registry provider
        PluginRegistryProvider.get(context).await
    }
}

/// TS-parity alias provider (delegates to `PluginRegistryProvider`).
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
        "n8n_plugin_registry"
    }

    fn description(&self) -> &'static str {
        "Delegates to PluginRegistryProvider for plugin existence checks"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        PluginRegistryProvider.get(context).await
    }
}
