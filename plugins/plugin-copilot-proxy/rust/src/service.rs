//! Service layer for the Copilot Proxy plugin.

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::client::CopilotProxyClient;
use crate::config::CopilotProxyConfig;
use crate::error::{CopilotProxyError, Result};
use crate::types::{TextGenerationParams, TextGenerationResult};

/// Service class for managing Copilot Proxy interactions.
pub struct CopilotProxyService {
    client: Arc<RwLock<Option<CopilotProxyClient>>>,
    config: CopilotProxyConfig,
    initialized: Arc<RwLock<bool>>,
}

impl CopilotProxyService {
    /// Create a new service with the given configuration.
    pub fn new(config: CopilotProxyConfig) -> Self {
        Self {
            client: Arc::new(RwLock::new(None)),
            config,
            initialized: Arc::new(RwLock::new(false)),
        }
    }

    /// Create a service from environment variables.
    pub fn from_env() -> Self {
        Self::new(CopilotProxyConfig::from_env())
    }

    /// Initialize the service.
    pub async fn initialize(&self) -> Result<()> {
        let mut initialized = self.initialized.write().await;
        if *initialized {
            return Ok(());
        }

        if !self.config.enabled {
            info!("[CopilotProxy] Plugin is disabled via COPILOT_PROXY_ENABLED=false");
            return Err(CopilotProxyError::Disabled);
        }

        let client = CopilotProxyClient::new(self.config.clone())?;

        // Check if the proxy server is available
        if client.health_check().await {
            info!(
                "[CopilotProxy] Successfully connected to proxy server at {}",
                self.config.base_url
            );
        } else {
            warn!(
                "[CopilotProxy] Proxy server is not available at {}. Make sure the Copilot Proxy VS Code extension is running.",
                self.config.base_url
            );
        }

        let mut client_guard = self.client.write().await;
        *client_guard = Some(client);
        *initialized = true;

        Ok(())
    }

    /// Check if the service is initialized and available.
    pub async fn is_available(&self) -> bool {
        let initialized = self.initialized.read().await;
        let client = self.client.read().await;
        *initialized && client.is_some()
    }

    /// Get a reference to the client.
    async fn get_client(&self) -> Result<impl std::ops::Deref<Target = CopilotProxyClient> + '_> {
        let client = self.client.read().await;
        if client.is_none() {
            return Err(CopilotProxyError::ConfigError(
                "Service not initialized".to_string(),
            ));
        }
        Ok(tokio::sync::RwLockReadGuard::map(client, |c| {
            c.as_ref().unwrap()
        }))
    }

    /// Get the small model ID.
    pub fn small_model(&self) -> &str {
        &self.config.small_model
    }

    /// Get the large model ID.
    pub fn large_model(&self) -> &str {
        &self.config.large_model
    }

    /// Get the context window size.
    pub fn context_window(&self) -> u32 {
        self.config.context_window
    }

    /// Get the max tokens setting.
    pub fn max_tokens(&self) -> u32 {
        self.config.max_tokens
    }

    /// Generate text using the specified parameters.
    pub async fn generate_text(&self, params: &TextGenerationParams) -> Result<TextGenerationResult> {
        let client = self.get_client().await?;
        client.generate_text(params).await
    }

    /// Generate text using the small model.
    pub async fn generate_text_small(&self, prompt: &str) -> Result<String> {
        debug!("[CopilotProxy] Generating text with small model");
        let client = self.get_client().await?;
        client.generate_text_small(prompt).await
    }

    /// Generate text using the small model with options.
    pub async fn generate_text_small_with_options(
        &self,
        prompt: &str,
        system: Option<&str>,
        max_tokens: Option<u32>,
        temperature: Option<f32>,
    ) -> Result<String> {
        let mut params = TextGenerationParams::new(prompt)
            .model(&self.config.small_model);

        if let Some(sys) = system {
            params = params.system(sys);
        }
        if let Some(tokens) = max_tokens {
            params = params.max_tokens(tokens);
        }
        if let Some(temp) = temperature {
            params = params.temperature(temp);
        }

        let result = self.generate_text(&params).await?;
        Ok(result.text)
    }

    /// Generate text using the large model.
    pub async fn generate_text_large(&self, prompt: &str) -> Result<String> {
        debug!("[CopilotProxy] Generating text with large model");
        let client = self.get_client().await?;
        client.generate_text_large(prompt).await
    }

    /// Generate text using the large model with options.
    pub async fn generate_text_large_with_options(
        &self,
        prompt: &str,
        system: Option<&str>,
        max_tokens: Option<u32>,
        temperature: Option<f32>,
    ) -> Result<String> {
        let mut params = TextGenerationParams::new(prompt)
            .model(&self.config.large_model);

        if let Some(sys) = system {
            params = params.system(sys);
        }
        if let Some(tokens) = max_tokens {
            params = params.max_tokens(tokens);
        }
        if let Some(temp) = temperature {
            params = params.temperature(temp);
        }

        let result = self.generate_text(&params).await?;
        Ok(result.text)
    }

    /// Generate a JSON object using the small model.
    pub async fn generate_object_small(&self, prompt: &str) -> Result<serde_json::Value> {
        debug!("[CopilotProxy] Generating object with small model");
        let client = self.get_client().await?;
        client.generate_object(prompt, Some(&self.config.small_model)).await
    }

    /// Generate a JSON object using the large model.
    pub async fn generate_object_large(&self, prompt: &str) -> Result<serde_json::Value> {
        debug!("[CopilotProxy] Generating object with large model");
        let client = self.get_client().await?;
        client.generate_object(prompt, Some(&self.config.large_model)).await
    }

    /// Shutdown the service.
    pub async fn shutdown(&self) {
        let mut client = self.client.write().await;
        *client = None;
        let mut initialized = self.initialized.write().await;
        *initialized = false;
        info!("[CopilotProxy] Service shut down");
    }
}

/// Global service instance.
static SERVICE: tokio::sync::OnceCell<CopilotProxyService> = tokio::sync::OnceCell::const_new();

/// Get or create the global service instance.
pub async fn get_service() -> &'static CopilotProxyService {
    SERVICE
        .get_or_init(|| async { CopilotProxyService::from_env() })
        .await
}

/// Initialize the global service.
pub async fn initialize_service() -> Result<()> {
    get_service().await.initialize().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_service_creation() {
        let config = CopilotProxyConfig::new().enabled(false);
        let service = CopilotProxyService::new(config);
        assert!(!service.is_available().await);
    }

    #[tokio::test]
    async fn test_disabled_service_initialization_returns_error() {
        let config = CopilotProxyConfig::new().enabled(false);
        let service = CopilotProxyService::new(config);
        let result = service.initialize().await;
        assert!(result.is_err());
    }

    #[test]
    fn test_model_accessors() {
        let config = CopilotProxyConfig::new()
            .small_model("model-small")
            .large_model("model-large")
            .context_window(32000)
            .max_tokens(2048);
        let service = CopilotProxyService::new(config);
        assert_eq!(service.small_model(), "model-small");
        assert_eq!(service.large_model(), "model-large");
        assert_eq!(service.context_window(), 32000);
        assert_eq!(service.max_tokens(), 2048);
    }

    #[tokio::test]
    async fn test_shutdown_resets_availability() {
        let config = CopilotProxyConfig::new().enabled(false);
        let service = CopilotProxyService::new(config);
        service.shutdown().await;
        assert!(!service.is_available().await);
    }

    #[tokio::test]
    async fn test_generate_text_before_init_fails() {
        let config = CopilotProxyConfig::new().enabled(true);
        let service = CopilotProxyService::new(config);
        // Not initialized, so generate_text_small should fail
        let result = service.generate_text_small("hello").await;
        assert!(result.is_err());
    }
}
