//! Copilot Proxy model provider plugin for elizaOS.
//!
//! This crate provides:
//! - A typed HTTP client for the Copilot Proxy server (`CopilotProxyClient`)
//! - A service layer for managing proxy interactions (`CopilotProxyService`)
//! - A high-level plugin wrapper (`CopilotProxyPlugin`)
//! - A helper to construct an elizaOS plugin definition

#![warn(missing_docs)]

/// HTTP client for the Copilot Proxy server.
pub mod client;
/// Configuration types.
pub mod config;
/// Error types and result aliases.
pub mod error;
/// Model provider implementations.
pub mod providers;
/// Service layer for managing interactions.
pub mod service;
/// Type definitions.
pub mod types;

pub use client::CopilotProxyClient;
pub use config::{
    normalize_base_url, CopilotProxyConfig, AVAILABLE_MODELS, DEFAULT_BASE_URL,
    DEFAULT_CONTEXT_WINDOW, DEFAULT_LARGE_MODEL, DEFAULT_MAX_TOKENS, DEFAULT_SMALL_MODEL,
    DEFAULT_TIMEOUT_SECONDS,
};
pub use error::{CopilotProxyError, Result};
pub use providers::{
    get_available_models, get_default_models, is_known_model, CopilotProxyModelProvider,
    ModelCost, ModelDefinition, ModelProviderConfig,
};
pub use service::{get_service, initialize_service, CopilotProxyService};
pub use types::{
    ChatCompletionChoice, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ChatRole,
    ModelInfo, ModelsResponse, TextGenerationParams, TextGenerationResult, TokenUsage,
};

use anyhow::Result as AnyhowResult;
use std::sync::Arc;

/// High-level Copilot Proxy plugin wrapper.
pub struct CopilotProxyPlugin {
    provider: CopilotProxyModelProvider,
}

impl CopilotProxyPlugin {
    /// Create a new plugin with the given configuration.
    pub fn new(config: CopilotProxyConfig) -> Result<Self> {
        config.validate()?;
        Ok(Self {
            provider: CopilotProxyModelProvider::new(config),
        })
    }

    /// Create a plugin from environment variables.
    pub fn from_env() -> Result<Self> {
        let config = CopilotProxyConfig::from_env();
        Self::new(config)
    }

    /// Initialize the plugin.
    pub async fn initialize(&self) -> Result<()> {
        self.provider.initialize().await
    }

    /// Check if the plugin is available.
    pub async fn is_available(&self) -> bool {
        self.provider.is_available().await
    }

    /// Generate text using the default (large) model.
    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        self.provider.generate_text_large(prompt).await
    }

    /// Generate text using the small model.
    pub async fn generate_text_small(&self, prompt: &str) -> Result<String> {
        self.provider.generate_text_small(prompt).await
    }

    /// Generate text using the large model.
    pub async fn generate_text_large(&self, prompt: &str) -> Result<String> {
        self.provider.generate_text_large(prompt).await
    }

    /// Generate a JSON object using the small model.
    pub async fn generate_object_small(&self, prompt: &str) -> Result<serde_json::Value> {
        self.provider.generate_object_small(prompt).await
    }

    /// Generate a JSON object using the large model.
    pub async fn generate_object_large(&self, prompt: &str) -> Result<serde_json::Value> {
        self.provider.generate_object_large(prompt).await
    }

    /// Get the model provider.
    pub fn provider(&self) -> &CopilotProxyModelProvider {
        &self.provider
    }

    /// Shutdown the plugin.
    pub async fn shutdown(&self) {
        self.provider.shutdown().await
    }
}

/// Construct a Copilot Proxy plugin from environment variables.
pub fn get_copilot_proxy_plugin() -> AnyhowResult<CopilotProxyPlugin> {
    CopilotProxyPlugin::from_env()
        .map_err(|e| anyhow::anyhow!("Failed to create Copilot Proxy plugin: {}", e))
}

/// Create an elizaOS plugin wired to Copilot Proxy model handlers.
pub fn create_copilot_proxy_elizaos_plugin() -> AnyhowResult<elizaos::types::Plugin> {
    use elizaos::types::{Plugin, PluginDefinition};
    use std::collections::HashMap;

    let plugin = Arc::new(get_copilot_proxy_plugin()?);

    let mut model_handlers: HashMap<String, elizaos::types::ModelHandlerFn> = HashMap::new();

    // TEXT_LARGE handler
    let plugin_large = plugin.clone();
    model_handlers.insert(
        "TEXT_LARGE".to_string(),
        Box::new(move |params: serde_json::Value| {
            let plugin = plugin_large.clone();
            Box::pin(async move {
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                plugin
                    .generate_text_large(prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("Copilot Proxy error: {}", e))
            })
        }),
    );

    // TEXT_SMALL handler
    let plugin_small = plugin.clone();
    model_handlers.insert(
        "TEXT_SMALL".to_string(),
        Box::new(move |params: serde_json::Value| {
            let plugin = plugin_small.clone();
            Box::pin(async move {
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                plugin
                    .generate_text_small(prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("Copilot Proxy error: {}", e))
            })
        }),
    );

    // OBJECT_LARGE handler
    let plugin_obj_large = plugin.clone();
    model_handlers.insert(
        "OBJECT_LARGE".to_string(),
        Box::new(move |params: serde_json::Value| {
            let plugin = plugin_obj_large.clone();
            Box::pin(async move {
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let result = plugin
                    .generate_object_large(prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("Copilot Proxy error: {}", e))?;
                Ok(serde_json::to_string(&result).unwrap_or_default())
            })
        }),
    );

    // OBJECT_SMALL handler
    let plugin_obj_small = plugin.clone();
    model_handlers.insert(
        "OBJECT_SMALL".to_string(),
        Box::new(move |params: serde_json::Value| {
            let plugin = plugin_obj_small.clone();
            Box::pin(async move {
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let result = plugin
                    .generate_object_small(prompt)
                    .await
                    .map_err(|e| anyhow::anyhow!("Copilot Proxy error: {}", e))?;
                Ok(serde_json::to_string(&result).unwrap_or_default())
            })
        }),
    );

    Ok(Plugin {
        definition: PluginDefinition {
            name: "copilot-proxy".to_string(),
            description: "Copilot Proxy model provider for elizaOS".to_string(),
            ..Default::default()
        },
        model_handlers,
        ..Default::default()
    })
}
