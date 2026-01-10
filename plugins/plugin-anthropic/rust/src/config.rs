//! Configuration for the Anthropic client.
//!
//! Configuration is loaded from environment variables or provided explicitly.
//! All required values must be present - no defaults for secrets.

use crate::error::{AnthropicError, Result};
use crate::models::Model;

/// Default API base URL.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

/// Default API version.
pub const DEFAULT_API_VERSION: &str = "2023-06-01";

/// Configuration for the Anthropic client.
#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    /// API key (required).
    api_key: String,
    /// Base URL for the API.
    base_url: String,
    /// API version string.
    api_version: String,
    /// Small model to use.
    small_model: Model,
    /// Large model to use.
    large_model: Model,
    /// Request timeout in seconds.
    timeout_seconds: u64,
}

impl AnthropicConfig {
    /// Create a new configuration with an API key.
    ///
    /// Uses default values for other settings.
    ///
    /// # Errors
    ///
    /// Returns an error if the API key is empty.
    pub fn new<S: Into<String>>(api_key: S) -> Result<Self> {
        let api_key = api_key.into();
        if api_key.trim().is_empty() {
            return Err(AnthropicError::api_key("API key cannot be empty"));
        }

        Ok(Self {
            api_key,
            base_url: DEFAULT_BASE_URL.to_string(),
            api_version: DEFAULT_API_VERSION.to_string(),
            small_model: Model::small(),
            large_model: Model::large(),
            timeout_seconds: 60,
        })
    }

    /// Load configuration from environment variables.
    ///
    /// Required:
    /// - ANTHROPIC_API_KEY
    ///
    /// Optional:
    /// - ANTHROPIC_BASE_URL (default: https://api.anthropic.com)
    /// - ANTHROPIC_SMALL_MODEL (default: claude-3-5-haiku-20241022)
    /// - ANTHROPIC_LARGE_MODEL (default: claude-sonnet-4-20250514)
    /// - ANTHROPIC_TIMEOUT_SECONDS (default: 60)
    ///
    /// # Errors
    ///
    /// Returns an error if ANTHROPIC_API_KEY is not set or is empty.
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
            AnthropicError::api_key(
                "ANTHROPIC_API_KEY environment variable is not set. \
                 Please set it to your Anthropic API key.",
            )
        })?;

        let mut config = Self::new(api_key)?;

        // Optional overrides
        if let Ok(base_url) = std::env::var("ANTHROPIC_BASE_URL") {
            if !base_url.is_empty() {
                config.base_url = base_url;
            }
        }

        if let Ok(model_id) = std::env::var("ANTHROPIC_SMALL_MODEL") {
            if !model_id.is_empty() {
                config.small_model = Model::new(model_id)?;
            }
        }

        if let Ok(model_id) = std::env::var("ANTHROPIC_LARGE_MODEL") {
            if !model_id.is_empty() {
                config.large_model = Model::new(model_id)?;
            }
        }

        if let Ok(timeout_str) = std::env::var("ANTHROPIC_TIMEOUT_SECONDS") {
            if let Ok(timeout) = timeout_str.parse::<u64>() {
                config.timeout_seconds = timeout;
            }
        }

        Ok(config)
    }

    /// Get the API key.
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    /// Get the base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Get the API version.
    pub fn api_version(&self) -> &str {
        &self.api_version
    }

    /// Get the small model.
    pub fn small_model(&self) -> &Model {
        &self.small_model
    }

    /// Get the large model.
    pub fn large_model(&self) -> &Model {
        &self.large_model
    }

    /// Get the timeout in seconds.
    pub fn timeout_seconds(&self) -> u64 {
        self.timeout_seconds
    }

    /// Set the base URL.
    pub fn with_base_url<S: Into<String>>(mut self, base_url: S) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// Set the small model.
    pub fn with_small_model(mut self, model: Model) -> Self {
        self.small_model = model;
        self
    }

    /// Set the large model.
    pub fn with_large_model(mut self, model: Model) -> Self {
        self.large_model = model;
        self
    }

    /// Set the timeout in seconds.
    pub fn with_timeout(mut self, seconds: u64) -> Self {
        self.timeout_seconds = seconds;
        self
    }

    /// Get the full messages endpoint URL.
    pub fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.base_url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = AnthropicConfig::new("test-key").unwrap();
        assert_eq!(config.api_key(), "test-key");
        assert_eq!(config.base_url(), DEFAULT_BASE_URL);
    }

    #[test]
    fn test_config_empty_key() {
        let result = AnthropicConfig::new("");
        assert!(result.is_err());

        let result = AnthropicConfig::new("   ");
        assert!(result.is_err());
    }

    #[test]
    fn test_config_builder() {
        let config = AnthropicConfig::new("test-key")
            .unwrap()
            .with_base_url("https://custom.api.com")
            .with_timeout(120);

        assert_eq!(config.base_url(), "https://custom.api.com");
        assert_eq!(config.timeout_seconds(), 120);
    }

    #[test]
    fn test_messages_url() {
        let config = AnthropicConfig::new("test-key").unwrap();
        assert_eq!(
            config.messages_url(),
            "https://api.anthropic.com/v1/messages"
        );
    }
}


