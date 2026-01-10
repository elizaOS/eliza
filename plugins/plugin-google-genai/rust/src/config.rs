//! Configuration for the Google GenAI client.
//!
//! Configuration is loaded from environment variables or provided explicitly.
//! All required values must be present - no defaults for secrets.

use crate::error::{GoogleGenAIError, Result};
use crate::models::Model;

/// Default API base URL.
pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// Default API version.
pub const DEFAULT_API_VERSION: &str = "v1beta";

/// Configuration for the Google GenAI client.
#[derive(Debug, Clone)]
pub struct GoogleGenAIConfig {
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
    /// Embedding model to use.
    embedding_model: Model,
    /// Image model to use.
    image_model: Model,
    /// Request timeout in seconds.
    timeout_seconds: u64,
}

impl GoogleGenAIConfig {
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
            return Err(GoogleGenAIError::api_key("API key cannot be empty"));
        }

        Ok(Self {
            api_key,
            base_url: DEFAULT_BASE_URL.to_string(),
            api_version: DEFAULT_API_VERSION.to_string(),
            small_model: Model::small(),
            large_model: Model::large(),
            embedding_model: Model::embedding(),
            image_model: Model::large(),
            timeout_seconds: 60,
        })
    }

    /// Load configuration from environment variables.
    ///
    /// Required:
    /// - GOOGLE_GENERATIVE_AI_API_KEY
    ///
    /// Optional:
    /// - GOOGLE_BASE_URL (default: https://generativelanguage.googleapis.com)
    /// - GOOGLE_SMALL_MODEL (default: gemini-2.0-flash-001)
    /// - GOOGLE_LARGE_MODEL (default: gemini-2.5-pro-preview-03-25)
    /// - GOOGLE_EMBEDDING_MODEL (default: text-embedding-004)
    /// - GOOGLE_IMAGE_MODEL (default: gemini-2.5-pro-preview-03-25)
    /// - GOOGLE_TIMEOUT_SECONDS (default: 60)
    ///
    /// # Errors
    ///
    /// Returns an error if GOOGLE_GENERATIVE_AI_API_KEY is not set or is empty.
    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("GOOGLE_GENERATIVE_AI_API_KEY").map_err(|_| {
            GoogleGenAIError::api_key(
                "GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set. \
                 Please set it to your Google AI API key.",
            )
        })?;

        let mut config = Self::new(api_key)?;

        // Optional overrides
        if let Ok(base_url) = std::env::var("GOOGLE_BASE_URL") {
            if !base_url.is_empty() {
                config.base_url = base_url;
            }
        }

        if let Ok(model_id) = std::env::var("GOOGLE_SMALL_MODEL") {
            if !model_id.is_empty() {
                config.small_model = Model::new(model_id)?;
            }
        }

        if let Ok(model_id) = std::env::var("GOOGLE_LARGE_MODEL") {
            if !model_id.is_empty() {
                config.large_model = Model::new(model_id)?;
            }
        }

        if let Ok(model_id) = std::env::var("GOOGLE_EMBEDDING_MODEL") {
            if !model_id.is_empty() {
                config.embedding_model = Model::new(model_id)?;
            }
        }

        if let Ok(model_id) = std::env::var("GOOGLE_IMAGE_MODEL") {
            if !model_id.is_empty() {
                config.image_model = Model::new(model_id)?;
            }
        }

        if let Ok(timeout_str) = std::env::var("GOOGLE_TIMEOUT_SECONDS") {
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

    /// Get the embedding model.
    pub fn embedding_model(&self) -> &Model {
        &self.embedding_model
    }

    /// Get the image model.
    pub fn image_model(&self) -> &Model {
        &self.image_model
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

    /// Get the full generateContent endpoint URL for a model.
    pub fn generate_content_url(&self, model: &Model) -> String {
        format!(
            "{}/{}/models/{}:generateContent?key={}",
            self.base_url,
            self.api_version,
            model.id(),
            self.api_key
        )
    }

    /// Get the full embedContent endpoint URL for a model.
    pub fn embed_content_url(&self, model: &Model) -> String {
        format!(
            "{}/{}/models/{}:embedContent?key={}",
            self.base_url,
            self.api_version,
            model.id(),
            self.api_key
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = GoogleGenAIConfig::new("test-key").unwrap();
        assert_eq!(config.api_key(), "test-key");
        assert_eq!(config.base_url(), DEFAULT_BASE_URL);
    }

    #[test]
    fn test_config_empty_key() {
        let result = GoogleGenAIConfig::new("");
        assert!(result.is_err());

        let result = GoogleGenAIConfig::new("   ");
        assert!(result.is_err());
    }

    #[test]
    fn test_config_builder() {
        let config = GoogleGenAIConfig::new("test-key")
            .unwrap()
            .with_base_url("https://custom.api.com")
            .with_timeout(120);

        assert_eq!(config.base_url(), "https://custom.api.com");
        assert_eq!(config.timeout_seconds(), 120);
    }

    #[test]
    fn test_generate_content_url() {
        let config = GoogleGenAIConfig::new("test-key").unwrap();
        let url = config.generate_content_url(&Model::small());
        assert!(url.contains("generateContent"));
        assert!(url.contains("test-key"));
    }
}

