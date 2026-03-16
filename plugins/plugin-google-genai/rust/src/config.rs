#![allow(missing_docs)]

use crate::error::{GoogleGenAIError, Result};
use crate::models::Model;

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";
pub const DEFAULT_API_VERSION: &str = "v1beta";

#[derive(Debug, Clone)]
pub struct GoogleGenAIConfig {
    api_key: String,
    base_url: String,
    api_version: String,
    small_model: Model,
    large_model: Model,
    embedding_model: Model,
    image_model: Model,
    timeout_seconds: u64,
}

impl GoogleGenAIConfig {
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

    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("GOOGLE_GENERATIVE_AI_API_KEY").map_err(|_| {
            GoogleGenAIError::api_key(
                "GOOGLE_GENERATIVE_AI_API_KEY environment variable is not set. \
                 Please set it to your Google AI API key.",
            )
        })?;

        let mut config = Self::new(api_key)?;

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

    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn api_version(&self) -> &str {
        &self.api_version
    }

    pub fn small_model(&self) -> &Model {
        &self.small_model
    }

    pub fn large_model(&self) -> &Model {
        &self.large_model
    }

    pub fn embedding_model(&self) -> &Model {
        &self.embedding_model
    }

    pub fn image_model(&self) -> &Model {
        &self.image_model
    }

    pub fn timeout_seconds(&self) -> u64 {
        self.timeout_seconds
    }

    pub fn with_base_url<S: Into<String>>(mut self, base_url: S) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_small_model(mut self, model: Model) -> Self {
        self.small_model = model;
        self
    }

    pub fn with_large_model(mut self, model: Model) -> Self {
        self.large_model = model;
        self
    }

    pub fn with_timeout(mut self, seconds: u64) -> Self {
        self.timeout_seconds = seconds;
        self
    }

    pub fn generate_content_url(&self, model: &Model) -> String {
        format!(
            "{}/{}/models/{}:generateContent?key={}",
            self.base_url,
            self.api_version,
            model.id(),
            self.api_key
        )
    }

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
