use crate::error::{AnthropicError, Result};
use crate::models::Model;

/// The default base URL for the Anthropic API.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// The default API version to use for requests.
pub const DEFAULT_API_VERSION: &str = "2023-06-01";

/// Configuration for the Anthropic client.
///
/// Contains all settings needed to connect to and interact with the Anthropic API,
/// including authentication, model selection, and timeout settings.
#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    api_key: String,
    base_url: String,
    api_version: String,
    small_model: Model,
    large_model: Model,
    timeout_seconds: u64,
}

impl AnthropicConfig {
    /// Creates a new configuration with the given API key.
    ///
    /// Uses default values for all other settings:
    /// - Base URL: `https://api.anthropic.com`
    /// - API Version: `2023-06-01`
    /// - Small Model: Claude 3.5 Haiku
    /// - Large Model: Claude Sonnet 4
    /// - Timeout: 60 seconds
    ///
    /// # Errors
    ///
    /// Returns an error if the API key is empty or contains only whitespace.
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

    /// Creates a configuration from environment variables.
    ///
    /// Reads the following environment variables:
    /// - `ANTHROPIC_API_KEY` (required): The API key for authentication
    /// - `ANTHROPIC_BASE_URL` (optional): Custom base URL
    /// - `ANTHROPIC_SMALL_MODEL` (optional): Model ID for small model
    /// - `ANTHROPIC_LARGE_MODEL` (optional): Model ID for large model
    /// - `ANTHROPIC_TIMEOUT_SECONDS` (optional): Request timeout in seconds
    ///
    /// # Errors
    ///
    /// Returns an error if `ANTHROPIC_API_KEY` is not set or if any
    /// provided model ID is invalid.
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
            AnthropicError::api_key(
                "ANTHROPIC_API_KEY environment variable is not set. \
                 Please set it to your Anthropic API key.",
            )
        })?;

        let mut config = Self::new(api_key)?;

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

    /// Returns the API key.
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    /// Returns the base URL for API requests.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Returns the API version string.
    pub fn api_version(&self) -> &str {
        &self.api_version
    }

    /// Returns a reference to the configured small model.
    pub fn small_model(&self) -> &Model {
        &self.small_model
    }

    /// Returns a reference to the configured large model.
    pub fn large_model(&self) -> &Model {
        &self.large_model
    }

    /// Returns the timeout in seconds for API requests.
    pub fn timeout_seconds(&self) -> u64 {
        self.timeout_seconds
    }

    /// Sets a custom base URL for API requests.
    pub fn with_base_url<S: Into<String>>(mut self, base_url: S) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// Sets the small model to use for generation.
    pub fn with_small_model(mut self, model: Model) -> Self {
        self.small_model = model;
        self
    }

    /// Sets the large model to use for generation.
    pub fn with_large_model(mut self, model: Model) -> Self {
        self.large_model = model;
        self
    }

    /// Sets the timeout in seconds for API requests.
    pub fn with_timeout(mut self, seconds: u64) -> Self {
        self.timeout_seconds = seconds;
        self
    }

    /// Returns the full URL for the messages API endpoint.
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
