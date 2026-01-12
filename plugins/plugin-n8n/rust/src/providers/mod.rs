mod capabilities;
mod exists;
mod registry;
mod status;

pub use capabilities::PluginCreationCapabilitiesProvider;
pub use exists::PluginExistsCheckProvider;
pub use exists::PluginExistsProvider;
pub use registry::PluginRegistryProvider;
pub use status::PluginCreationStatusProvider;

use async_trait::async_trait;
use serde_json::Value;

/// Context provided to n8n providers for data retrieval.
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// The current state as a JSON value.
    pub state: Value,
}

/// Result returned from an n8n provider.
#[derive(Debug, Clone, Default)]
pub struct ProviderResult {
    /// Human-readable text describing the provider data.
    pub text: String,
    /// Optional structured data from the provider.
    pub data: Option<Value>,
}

/// Trait defining the interface for n8n providers.
#[async_trait]
pub trait N8nProvider: Send + Sync {
    /// Returns the unique name identifier for this provider.
    fn name(&self) -> &'static str;
    /// Returns a human-readable description of what this provider provides.
    fn description(&self) -> &'static str;
    /// Retrieves data from this provider based on the given context.
    async fn get(&self, context: &ProviderContext) -> ProviderResult;
}
