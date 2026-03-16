//! elizaOS Bootstrap Plugin - Rust implementation.
pub mod error;
pub mod runtime;
pub mod services;
pub mod types;
pub mod xml;

use error::PluginResult;
use runtime::IAgentRuntime;
use services::Service;
use std::sync::Arc;
pub use types::CapabilityConfig;

pub struct BootstrapPlugin {
    pub name: &'static str,
    pub description: &'static str,
    config: CapabilityConfig,
}

impl BootstrapPlugin {
    pub fn new() -> Self {
        Self::with_config(CapabilityConfig::default())
    }

    pub fn with_config(config: CapabilityConfig) -> Self {
        Self {
            name: "bootstrap",
            description: "elizaOS Bootstrap Plugin (Minimal)",
            config,
        }
    }

    pub async fn init(&self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("plugin:bootstrap", "Initializing Bootstrap plugin");
        if !self.config.disable_basic {
            let mut task_service = services::TaskService::new();
            task_service.start(runtime.clone()).await?;

            let mut embedding_service = services::EmbeddingService::new();
            embedding_service.start(runtime.clone()).await?;
        }
        Ok(())
    }

    pub fn name(&self) -> &'static str {
        self.name
    }
    pub fn description(&self) -> &'static str {
        self.description
    }
}

impl Default for BootstrapPlugin {
    fn default() -> Self {
        Self::new()
    }
}
