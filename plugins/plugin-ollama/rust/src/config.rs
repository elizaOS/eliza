#![allow(missing_docs)]
//! Configuration for the Ollama client.
//!
//! Configuration is loaded from environment variables or provided explicitly.

use crate::error::Result;

/// Default API base URL.
pub const DEFAULT_BASE_URL: &str = "http://localhost:11434";

/// Default small model.
pub const DEFAULT_SMALL_MODEL: &str = "gemma3:latest";

/// Default large model.
pub const DEFAULT_LARGE_MODEL: &str = "gemma3:latest";

/// Default embedding model.
pub const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text:latest";

/// Configuration for the Ollama client.
#[derive(Debug, Clone)]
pub struct OllamaConfig {
    /// Base URL for the Ollama API.
    base_url: String,
    /// Small model to use.
    small_model: String,
    /// Large model to use.
    large_model: String,
    /// Embedding model to use.
    embedding_model: String,
    /// Request timeout in seconds.
    timeout_seconds: u64,
}


impl Default for OllamaConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            small_model: DEFAULT_SMALL_MODEL.to_string(),
            large_model: DEFAULT_LARGE_MODEL.to_string(),
            embedding_model: DEFAULT_EMBEDDING_MODEL.to_string(),
            timeout_seconds: 300,
        }
    }
}

impl OllamaConfig {
    /// Create a new configuration with defaults.
    pub fn new() -> Self {
        Self::default()
    }

    /// Load configuration from environment variables.
    ///
    /// Environment variables:
    /// - OLLAMA_API_ENDPOINT or OLLAMA_API_URL: Base URL
    /// - OLLAMA_SMALL_MODEL or SMALL_MODEL: Small model name
    /// - OLLAMA_LARGE_MODEL or LARGE_MODEL: Large model name
    /// - OLLAMA_EMBEDDING_MODEL: Embedding model name
    /// - OLLAMA_TIMEOUT_SECONDS: Request timeout
    ///
    /// # Errors
    ///
    /// Returns an error if configuration is invalid.
    pub fn from_env() -> Result<Self> {
        let base_url = std::env::var("OLLAMA_API_ENDPOINT")
            .or_else(|_| std::env::var("OLLAMA_API_URL"))
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());

        let small_model = std::env::var("OLLAMA_SMALL_MODEL")
            .or_else(|_| std::env::var("SMALL_MODEL"))
            .unwrap_or_else(|_| DEFAULT_SMALL_MODEL.to_string());

        let large_model = std::env::var("OLLAMA_LARGE_MODEL")
            .or_else(|_| std::env::var("LARGE_MODEL"))
            .unwrap_or_else(|_| DEFAULT_LARGE_MODEL.to_string());

        let embedding_model = std::env::var("OLLAMA_EMBEDDING_MODEL")
            .unwrap_or_else(|_| DEFAULT_EMBEDDING_MODEL.to_string());

        let timeout_seconds = std::env::var("OLLAMA_TIMEOUT_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300);

        Ok(Self {
            base_url,
            small_model,
            large_model,
            embedding_model,
            timeout_seconds,
        })
    }

    /// Get the base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Get the small model name.
    pub fn small_model(&self) -> &str {
        &self.small_model
    }

    /// Get the large model name.
    pub fn large_model(&self) -> &str {
        &self.large_model
    }

    /// Get the embedding model name.
    pub fn embedding_model(&self) -> &str {
        &self.embedding_model
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
    pub fn with_small_model<S: Into<String>>(mut self, model: S) -> Self {
        self.small_model = model.into();
        self
    }

    /// Set the large model.
    pub fn with_large_model<S: Into<String>>(mut self, model: S) -> Self {
        self.large_model = model.into();
        self
    }

    /// Set the embedding model.
    pub fn with_embedding_model<S: Into<String>>(mut self, model: S) -> Self {
        self.embedding_model = model.into();
        self
    }

    /// Set the timeout in seconds.
    pub fn with_timeout(mut self, seconds: u64) -> Self {
        self.timeout_seconds = seconds;
        self
    }

    /// Get the generate endpoint URL.
    pub fn generate_url(&self) -> String {
        format!("{}/api/generate", self.base_url)
    }

    /// Get the chat endpoint URL.
    pub fn chat_url(&self) -> String {
        format!("{}/api/chat", self.base_url)
    }

    /// Get the embeddings endpoint URL.
    pub fn embeddings_url(&self) -> String {
        format!("{}/api/embeddings", self.base_url)
    }

    /// Get the show endpoint URL.
    pub fn show_url(&self) -> String {
        format!("{}/api/show", self.base_url)
    }

    /// Get the pull endpoint URL.
    pub fn pull_url(&self) -> String {
        format!("{}/api/pull", self.base_url)
    }

    /// Get the tags endpoint URL.
    pub fn tags_url(&self) -> String {
        format!("{}/api/tags", self.base_url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = OllamaConfig::default();
        assert_eq!(config.base_url(), DEFAULT_BASE_URL);
        assert_eq!(config.small_model(), DEFAULT_SMALL_MODEL);
        assert_eq!(config.large_model(), DEFAULT_LARGE_MODEL);
    }

    #[test]
    fn test_config_builder() {
        let config = OllamaConfig::new()
            .with_base_url("http://custom:8080")
            .with_small_model("custom-small")
            .with_timeout(60);

        assert_eq!(config.base_url(), "http://custom:8080");
        assert_eq!(config.small_model(), "custom-small");
        assert_eq!(config.timeout_seconds(), 60);
    }

    #[test]
    fn test_generate_url() {
        let config = OllamaConfig::new();
        assert_eq!(
            config.generate_url(),
            "http://localhost:11434/api/generate"
        );
        assert_eq!(
            config.embeddings_url(),
            "http://localhost:11434/api/embeddings"
        );
    }
}


