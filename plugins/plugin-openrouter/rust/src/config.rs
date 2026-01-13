#![allow(missing_docs)]

use crate::error::{OpenRouterError, Result};

pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const DEFAULT_SMALL_MODEL: &str = "google/gemini-2.0-flash-001";
pub const DEFAULT_LARGE_MODEL: &str = "google/gemini-2.5-flash";
pub const DEFAULT_IMAGE_MODEL: &str = "x-ai/grok-2-vision-1212";
pub const DEFAULT_EMBEDDING_MODEL: &str = "openai/text-embedding-3-small";
pub const DEFAULT_EMBEDDING_DIMENSIONS: u32 = 1536;

#[derive(Debug, Clone)]
pub struct OpenRouterConfig {
    api_key: String,
    base_url: String,
    small_model: String,
    large_model: String,
    image_model: String,
    embedding_model: String,
    embedding_dimensions: u32,
    timeout_seconds: u64,
}

impl OpenRouterConfig {
    pub fn new<S: Into<String>>(api_key: S) -> Result<Self> {
        let api_key = api_key.into();
        if api_key.trim().is_empty() {
            return Err(OpenRouterError::api_key("API key cannot be empty"));
        }

        Ok(Self {
            api_key,
            base_url: DEFAULT_BASE_URL.to_string(),
            small_model: DEFAULT_SMALL_MODEL.to_string(),
            large_model: DEFAULT_LARGE_MODEL.to_string(),
            image_model: DEFAULT_IMAGE_MODEL.to_string(),
            embedding_model: DEFAULT_EMBEDDING_MODEL.to_string(),
            embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
            timeout_seconds: 60,
        })
    }

    pub fn from_env() -> Result<Self> {
        let api_key = std::env::var("OPENROUTER_API_KEY").map_err(|_| {
            OpenRouterError::api_key(
                "OPENROUTER_API_KEY environment variable is not set. \
                 Please set it to your OpenRouter API key.",
            )
        })?;

        let mut config = Self::new(api_key)?;

        if let Ok(base_url) = std::env::var("OPENROUTER_BASE_URL") {
            if !base_url.is_empty() {
                config.base_url = base_url;
            }
        }

        if let Ok(model) =
            std::env::var("OPENROUTER_SMALL_MODEL").or_else(|_| std::env::var("SMALL_MODEL"))
        {
            if !model.is_empty() {
                config.small_model = model;
            }
        }

        if let Ok(model) =
            std::env::var("OPENROUTER_LARGE_MODEL").or_else(|_| std::env::var("LARGE_MODEL"))
        {
            if !model.is_empty() {
                config.large_model = model;
            }
        }

        if let Ok(model) =
            std::env::var("OPENROUTER_IMAGE_MODEL").or_else(|_| std::env::var("IMAGE_MODEL"))
        {
            if !model.is_empty() {
                config.image_model = model;
            }
        }

        if let Ok(model) = std::env::var("OPENROUTER_EMBEDDING_MODEL")
            .or_else(|_| std::env::var("EMBEDDING_MODEL"))
        {
            if !model.is_empty() {
                config.embedding_model = model;
            }
        }

        if let Ok(dims_str) = std::env::var("OPENROUTER_EMBEDDING_DIMENSIONS")
            .or_else(|_| std::env::var("EMBEDDING_DIMENSIONS"))
        {
            if let Ok(dims) = dims_str.parse::<u32>() {
                config.embedding_dimensions = dims;
            }
        }

        if let Ok(timeout_str) = std::env::var("OPENROUTER_TIMEOUT_SECONDS") {
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

    pub fn small_model(&self) -> &str {
        &self.small_model
    }

    pub fn large_model(&self) -> &str {
        &self.large_model
    }

    pub fn image_model(&self) -> &str {
        &self.image_model
    }

    pub fn embedding_model(&self) -> &str {
        &self.embedding_model
    }

    pub fn embedding_dimensions(&self) -> u32 {
        self.embedding_dimensions
    }

    pub fn timeout_seconds(&self) -> u64 {
        self.timeout_seconds
    }

    pub fn with_base_url<S: Into<String>>(mut self, base_url: S) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_small_model<S: Into<String>>(mut self, model: S) -> Self {
        self.small_model = model.into();
        self
    }

    pub fn with_large_model<S: Into<String>>(mut self, model: S) -> Self {
        self.large_model = model.into();
        self
    }

    pub fn with_embedding_model<S: Into<String>>(mut self, model: S) -> Self {
        self.embedding_model = model.into();
        self
    }

    pub fn with_timeout(mut self, seconds: u64) -> Self {
        self.timeout_seconds = seconds;
        self
    }

    pub fn chat_completions_url(&self) -> String {
        format!("{}/chat/completions", self.base_url)
    }

    pub fn embeddings_url(&self) -> String {
        format!("{}/embeddings", self.base_url)
    }

    pub fn models_url(&self) -> String {
        format!("{}/models", self.base_url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = OpenRouterConfig::new("test-key").unwrap();
        assert_eq!(config.api_key(), "test-key");
        assert_eq!(config.base_url(), DEFAULT_BASE_URL);
    }

    #[test]
    fn test_config_empty_key() {
        let result = OpenRouterConfig::new("");
        assert!(result.is_err());

        let result = OpenRouterConfig::new("   ");
        assert!(result.is_err());
    }

    #[test]
    fn test_config_builder() {
        let config = OpenRouterConfig::new("test-key")
            .unwrap()
            .with_base_url("https://custom.api.com")
            .with_small_model("custom-small")
            .with_timeout(120);

        assert_eq!(config.base_url(), "https://custom.api.com");
        assert_eq!(config.small_model(), "custom-small");
        assert_eq!(config.timeout_seconds(), 120);
    }

    #[test]
    fn test_urls() {
        let config = OpenRouterConfig::new("test-key").unwrap();
        assert_eq!(
            config.chat_completions_url(),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            config.embeddings_url(),
            "https://openrouter.ai/api/v1/embeddings"
        );
    }
}
