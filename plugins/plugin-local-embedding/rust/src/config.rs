#![allow(missing_docs)]

use std::path::PathBuf;

use crate::error::Result;

/// Default embedding model name for fastembed (ONNX-based).
pub const DEFAULT_EMBEDDING_MODEL: &str = "BAAI/bge-small-en-v1.5";

/// Default GGUF model filename (for reference / download from HuggingFace).
pub const DEFAULT_EMBEDDING_MODEL_GGUF: &str = "bge-small-en-v1.5.Q4_K_M.gguf";

/// Default embedding vector dimensionality.
pub const DEFAULT_EMBEDDING_DIMENSIONS: usize = 384;

/// Default HuggingFace tokenizer identifier.
pub const DEFAULT_TOKENIZER_NAME: &str = "BAAI/bge-small-en-v1.5";

/// Configuration for the local embedding plugin.
///
/// Controls which models are used, where files are stored, and
/// expected embedding dimensions.
#[derive(Debug, Clone)]
pub struct LocalEmbeddingConfig {
    embedding_model: String,
    embedding_model_gguf: String,
    models_dir: PathBuf,
    cache_dir: PathBuf,
    embedding_dimensions: usize,
    tokenizer_name: String,
}

impl Default for LocalEmbeddingConfig {
    fn default() -> Self {
        let home = Self::default_home_dir();
        Self {
            embedding_model: DEFAULT_EMBEDDING_MODEL.to_string(),
            embedding_model_gguf: DEFAULT_EMBEDDING_MODEL_GGUF.to_string(),
            models_dir: home.join(".eliza").join("models"),
            cache_dir: home.join(".eliza").join("cache"),
            embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
            tokenizer_name: DEFAULT_TOKENIZER_NAME.to_string(),
        }
    }
}

impl LocalEmbeddingConfig {
    /// Create a new config with default values.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a config by reading from environment variables.
    ///
    /// Supported variables:
    /// - `LOCAL_EMBEDDING_MODEL` — embedding model identifier (default: BAAI/bge-small-en-v1.5)
    /// - `LOCAL_EMBEDDING_MODEL_GGUF` — GGUF model filename for HuggingFace downloads
    /// - `MODELS_DIR` — path to models directory (default: ~/.eliza/models)
    /// - `CACHE_DIR` — path to cache directory (default: ~/.eliza/cache)
    /// - `LOCAL_EMBEDDING_DIMENSIONS` — embedding dimensions (default: 384)
    /// - `LOCAL_TOKENIZER_NAME` — HuggingFace tokenizer identifier
    pub fn from_env() -> Result<Self> {
        let home = Self::default_home_dir();

        let embedding_model = std::env::var("LOCAL_EMBEDDING_MODEL")
            .unwrap_or_else(|_| DEFAULT_EMBEDDING_MODEL.to_string());

        let embedding_model_gguf = std::env::var("LOCAL_EMBEDDING_MODEL_GGUF")
            .unwrap_or_else(|_| DEFAULT_EMBEDDING_MODEL_GGUF.to_string());

        let models_dir = std::env::var("MODELS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".eliza").join("models"));

        let cache_dir = std::env::var("CACHE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".eliza").join("cache"));

        let embedding_dimensions = std::env::var("LOCAL_EMBEDDING_DIMENSIONS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_EMBEDDING_DIMENSIONS);

        let tokenizer_name = std::env::var("LOCAL_TOKENIZER_NAME")
            .unwrap_or_else(|_| DEFAULT_TOKENIZER_NAME.to_string());

        Ok(Self {
            embedding_model,
            embedding_model_gguf,
            models_dir,
            cache_dir,
            embedding_dimensions,
            tokenizer_name,
        })
    }

    // ---- Getters ----

    /// The embedding model identifier (e.g. "BAAI/bge-small-en-v1.5").
    pub fn embedding_model(&self) -> &str {
        &self.embedding_model
    }

    /// The GGUF model filename for HuggingFace downloads.
    pub fn embedding_model_gguf(&self) -> &str {
        &self.embedding_model_gguf
    }

    /// Path to the models directory.
    pub fn models_dir(&self) -> &PathBuf {
        &self.models_dir
    }

    /// Path to the cache directory.
    pub fn cache_dir(&self) -> &PathBuf {
        &self.cache_dir
    }

    /// Expected embedding vector dimensionality.
    pub fn embedding_dimensions(&self) -> usize {
        self.embedding_dimensions
    }

    /// HuggingFace tokenizer identifier.
    pub fn tokenizer_name(&self) -> &str {
        &self.tokenizer_name
    }

    // ---- Builder methods ----

    /// Override the embedding model identifier.
    pub fn with_embedding_model<S: Into<String>>(mut self, model: S) -> Self {
        self.embedding_model = model.into();
        self
    }

    /// Override the models directory path.
    pub fn with_models_dir<P: Into<PathBuf>>(mut self, dir: P) -> Self {
        self.models_dir = dir.into();
        self
    }

    /// Override the cache directory path.
    pub fn with_cache_dir<P: Into<PathBuf>>(mut self, dir: P) -> Self {
        self.cache_dir = dir.into();
        self
    }

    /// Override the embedding dimensions.
    pub fn with_embedding_dimensions(mut self, dimensions: usize) -> Self {
        self.embedding_dimensions = dimensions;
        self
    }

    /// Override the tokenizer identifier.
    pub fn with_tokenizer_name<S: Into<String>>(mut self, name: S) -> Self {
        self.tokenizer_name = name.into();
        self
    }

    /// Resolve the user home directory from environment variables.
    fn default_home_dir() -> PathBuf {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default() {
        let config = LocalEmbeddingConfig::default();
        assert_eq!(config.embedding_model(), DEFAULT_EMBEDDING_MODEL);
        assert_eq!(config.embedding_dimensions(), DEFAULT_EMBEDDING_DIMENSIONS);
        assert_eq!(config.tokenizer_name(), DEFAULT_TOKENIZER_NAME);
        assert_eq!(config.embedding_model_gguf(), DEFAULT_EMBEDDING_MODEL_GGUF);
    }

    #[test]
    fn test_config_new_equals_default() {
        let new_config = LocalEmbeddingConfig::new();
        let default_config = LocalEmbeddingConfig::default();
        assert_eq!(new_config.embedding_model(), default_config.embedding_model());
        assert_eq!(
            new_config.embedding_dimensions(),
            default_config.embedding_dimensions()
        );
    }

    #[test]
    fn test_config_builder() {
        let config = LocalEmbeddingConfig::new()
            .with_embedding_model("custom-model")
            .with_embedding_dimensions(768)
            .with_tokenizer_name("custom-tokenizer")
            .with_cache_dir("/tmp/cache")
            .with_models_dir("/tmp/models");

        assert_eq!(config.embedding_model(), "custom-model");
        assert_eq!(config.embedding_dimensions(), 768);
        assert_eq!(config.tokenizer_name(), "custom-tokenizer");
        assert_eq!(config.cache_dir(), &PathBuf::from("/tmp/cache"));
        assert_eq!(config.models_dir(), &PathBuf::from("/tmp/models"));
    }

    #[test]
    fn test_config_from_env() {
        // from_env should work even without env vars set (uses defaults)
        let config = LocalEmbeddingConfig::from_env();
        assert!(config.is_ok());
        let config = config.unwrap();
        assert_eq!(config.embedding_model(), DEFAULT_EMBEDDING_MODEL);
        assert_eq!(config.embedding_dimensions(), DEFAULT_EMBEDDING_DIMENSIONS);
    }

    #[test]
    fn test_config_default_paths_contain_eliza() {
        let config = LocalEmbeddingConfig::default();
        let models_str = config.models_dir().to_string_lossy();
        let cache_str = config.cache_dir().to_string_lossy();
        assert!(
            models_str.contains(".eliza"),
            "models_dir should contain .eliza: {models_str}"
        );
        assert!(
            cache_str.contains(".eliza"),
            "cache_dir should contain .eliza: {cache_str}"
        );
    }
}
