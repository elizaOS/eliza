//! Model provider for Copilot Proxy.

use crate::config::{CopilotProxyConfig, AVAILABLE_MODELS};
use crate::service::CopilotProxyService;

/// Model definition for Copilot Proxy.
#[derive(Debug, Clone)]
pub struct ModelDefinition {
    /// The model ID.
    pub id: String,
    /// The model name.
    pub name: String,
    /// The API type.
    pub api: &'static str,
    /// Whether the model supports reasoning.
    pub reasoning: bool,
    /// Supported input types.
    pub input: Vec<&'static str>,
    /// Cost information.
    pub cost: ModelCost,
    /// Context window size.
    pub context_window: u32,
    /// Maximum tokens.
    pub max_tokens: u32,
}

/// Cost information for a model.
#[derive(Debug, Clone, Default)]
pub struct ModelCost {
    /// Input cost per token.
    pub input: f64,
    /// Output cost per token.
    pub output: f64,
    /// Cache read cost per token.
    pub cache_read: f64,
    /// Cache write cost per token.
    pub cache_write: f64,
}

impl ModelDefinition {
    /// Create a new model definition.
    pub fn new(
        id: impl Into<String>,
        context_window: u32,
        max_tokens: u32,
    ) -> Self {
        let id = id.into();
        Self {
            name: id.clone(),
            id,
            api: "openai-completions",
            reasoning: false,
            input: vec!["text", "image"],
            cost: ModelCost::default(),
            context_window,
            max_tokens,
        }
    }
}

/// Model provider configuration.
#[derive(Debug, Clone)]
pub struct ModelProviderConfig {
    /// Base URL for the proxy server.
    pub base_url: String,
    /// Small model ID.
    pub small_model: String,
    /// Large model ID.
    pub large_model: String,
    /// Context window size.
    pub context_window: u32,
    /// Maximum tokens.
    pub max_tokens: u32,
}

impl From<&CopilotProxyConfig> for ModelProviderConfig {
    fn from(config: &CopilotProxyConfig) -> Self {
        Self {
            base_url: config.base_url.clone(),
            small_model: config.small_model.clone(),
            large_model: config.large_model.clone(),
            context_window: config.context_window,
            max_tokens: config.max_tokens,
        }
    }
}

/// Get all available model definitions.
pub fn get_available_models(
    context_window: u32,
    max_tokens: u32,
) -> Vec<ModelDefinition> {
    AVAILABLE_MODELS
        .iter()
        .map(|id| ModelDefinition::new(*id, context_window, max_tokens))
        .collect()
}

/// Get the default available models.
pub fn get_default_models() -> Vec<ModelDefinition> {
    get_available_models(128_000, 8192)
}

/// Check if a model ID is a known model.
pub fn is_known_model(model_id: &str) -> bool {
    AVAILABLE_MODELS.contains(&model_id)
}

/// Model provider for Copilot Proxy.
pub struct CopilotProxyModelProvider {
    service: CopilotProxyService,
}

impl CopilotProxyModelProvider {
    /// Create a new model provider.
    pub fn new(config: CopilotProxyConfig) -> Self {
        Self {
            service: CopilotProxyService::new(config),
        }
    }

    /// Create a model provider from environment variables.
    pub fn from_env() -> Self {
        Self {
            service: CopilotProxyService::from_env(),
        }
    }

    /// Initialize the provider.
    pub async fn initialize(&self) -> crate::error::Result<()> {
        self.service.initialize().await
    }

    /// Check if the provider is available.
    pub async fn is_available(&self) -> bool {
        self.service.is_available().await
    }

    /// Get the service reference.
    pub fn service(&self) -> &CopilotProxyService {
        &self.service
    }

    /// Get the small model ID.
    pub fn small_model(&self) -> &str {
        self.service.small_model()
    }

    /// Get the large model ID.
    pub fn large_model(&self) -> &str {
        self.service.large_model()
    }

    /// Generate text using the small model.
    pub async fn generate_text_small(&self, prompt: &str) -> crate::error::Result<String> {
        self.service.generate_text_small(prompt).await
    }

    /// Generate text using the large model.
    pub async fn generate_text_large(&self, prompt: &str) -> crate::error::Result<String> {
        self.service.generate_text_large(prompt).await
    }

    /// Generate a JSON object using the small model.
    pub async fn generate_object_small(
        &self,
        prompt: &str,
    ) -> crate::error::Result<serde_json::Value> {
        self.service.generate_object_small(prompt).await
    }

    /// Generate a JSON object using the large model.
    pub async fn generate_object_large(
        &self,
        prompt: &str,
    ) -> crate::error::Result<serde_json::Value> {
        self.service.generate_object_large(prompt).await
    }

    /// Shutdown the provider.
    pub async fn shutdown(&self) {
        self.service.shutdown().await
    }
}
