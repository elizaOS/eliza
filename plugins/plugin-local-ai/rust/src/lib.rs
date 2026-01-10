//! Local AI Plugin for elizaOS
//!
//! This crate provides local LLM inference for elizaOS agents.
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_local_ai::LocalAIPlugin;
//!
//! # async fn example() -> anyhow::Result<()> {
//! let plugin = LocalAIPlugin::from_env()?;
//! let response = plugin.generate_text("Hello, world!").await?;
//! println!("{}", response);
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod error;
pub mod types;

pub use error::{LocalAIError, Result};
pub use types::*;

use std::path::PathBuf;
use anyhow::Result as AnyhowResult;

/// Local AI plugin configuration.
#[derive(Debug, Clone)]
pub struct LocalAIConfig {
    /// Directory containing model files
    pub models_dir: PathBuf,
    /// Directory for caching
    pub cache_dir: PathBuf,
    /// Small model filename
    pub small_model: String,
    /// Large model filename
    pub large_model: String,
    /// Embedding model filename
    pub embedding_model: String,
    /// Embedding dimensions
    pub embedding_dimensions: usize,
    /// Number of GPU layers to use
    pub gpu_layers: u32,
    /// Context size
    pub context_size: usize,
}

impl Default for LocalAIConfig {
    fn default() -> Self {
        let home = directories::BaseDirs::new()
            .map(|d| d.home_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        Self {
            models_dir: home.join(".eliza").join("models"),
            cache_dir: home.join(".eliza").join("cache"),
            small_model: "DeepHermes-3-Llama-3-3B-Preview-q4.gguf".to_string(),
            large_model: "DeepHermes-3-Llama-3-8B-q4.gguf".to_string(),
            embedding_model: "bge-small-en-v1.5.Q4_K_M.gguf".to_string(),
            embedding_dimensions: 384,
            gpu_layers: 0,
            context_size: 8192,
        }
    }
}

impl LocalAIConfig {
    /// Create a new configuration with custom models directory.
    pub fn new(models_dir: impl Into<PathBuf>) -> Self {
        let models_dir = models_dir.into();
        Self {
            models_dir,
            ..Default::default()
        }
    }

    /// Set the small model filename.
    pub fn small_model(mut self, model: impl Into<String>) -> Self {
        self.small_model = model.into();
        self
    }

    /// Set the large model filename.
    pub fn large_model(mut self, model: impl Into<String>) -> Self {
        self.large_model = model.into();
        self
    }

    /// Set the embedding model filename.
    pub fn embedding_model(mut self, model: impl Into<String>) -> Self {
        self.embedding_model = model.into();
        self
    }

    /// Set the number of GPU layers.
    pub fn gpu_layers(mut self, layers: u32) -> Self {
        self.gpu_layers = layers;
        self
    }

    /// Set the context size.
    pub fn context_size(mut self, size: usize) -> Self {
        self.context_size = size;
        self
    }
}

/// Local AI plugin for elizaOS.
///
/// This struct provides local LLM inference capabilities.
pub struct LocalAIPlugin {
    config: LocalAIConfig,
}

impl LocalAIPlugin {
    /// Create a new LocalAIPlugin with the given configuration.
    pub fn new(config: LocalAIConfig) -> Result<Self> {
        // Ensure directories exist
        std::fs::create_dir_all(&config.models_dir)
            .map_err(|e| LocalAIError::IoError(e.to_string()))?;
        std::fs::create_dir_all(&config.cache_dir)
            .map_err(|e| LocalAIError::IoError(e.to_string()))?;

        Ok(Self { config })
    }

    /// Create a LocalAIPlugin from environment variables.
    pub fn from_env() -> AnyhowResult<Self> {
        let mut config = LocalAIConfig::default();

        if let Ok(dir) = std::env::var("MODELS_DIR") {
            config.models_dir = PathBuf::from(dir);
        }

        if let Ok(dir) = std::env::var("CACHE_DIR") {
            config.cache_dir = PathBuf::from(dir);
        }

        if let Ok(model) = std::env::var("LOCAL_SMALL_MODEL") {
            config.small_model = model;
        }

        if let Ok(model) = std::env::var("LOCAL_LARGE_MODEL") {
            config.large_model = model;
        }

        if let Ok(model) = std::env::var("LOCAL_EMBEDDING_MODEL") {
            config.embedding_model = model;
        }

        if let Ok(dims) = std::env::var("LOCAL_EMBEDDING_DIMENSIONS") {
            config.embedding_dimensions = dims.parse().unwrap_or(384);
        }

        Self::new(config).map_err(|e| anyhow::anyhow!("Failed to create Local AI plugin: {}", e))
    }

    /// Generate text from a prompt.
    ///
    /// Note: This is a placeholder. In a real implementation, you would use
    /// llama-cpp-rs or similar bindings to run inference.
    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        self.generate_text_with_params(&params).await
    }

    /// Generate text with full parameters.
    pub async fn generate_text_with_params(&self, params: &TextGenerationParams) -> Result<String> {
        // This is a placeholder implementation.
        // In a real implementation, you would:
        // 1. Load the model using llama-cpp-rs
        // 2. Create a context
        // 3. Run inference
        // 4. Return the generated text

        let model_path = if params.use_large_model {
            self.config.models_dir.join(&self.config.large_model)
        } else {
            self.config.models_dir.join(&self.config.small_model)
        };

        if !model_path.exists() {
            return Err(LocalAIError::ModelNotFound(
                model_path.display().to_string(),
            ));
        }

        // Placeholder: In production, use llama-cpp-rs here
        tracing::info!(
            "Would generate text using model: {}",
            model_path.display()
        );

        Ok(format!(
            "Local AI response to: {}... (placeholder - implement with llama-cpp-rs)",
            &params.prompt[..params.prompt.len().min(50)]
        ))
    }

    /// Create an embedding for text.
    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.create_embedding_with_params(&params).await
    }

    /// Create an embedding with full parameters.
    pub async fn create_embedding_with_params(&self, _params: &EmbeddingParams) -> Result<Vec<f32>> {
        let model_path = self.config.models_dir.join(&self.config.embedding_model);

        if !model_path.exists() {
            return Err(LocalAIError::ModelNotFound(
                model_path.display().to_string(),
            ));
        }

        // Placeholder: Return zero vector with correct dimensions
        // In production, use llama-cpp-rs with embedding mode
        tracing::info!(
            "Would create embedding using model: {}",
            model_path.display()
        );

        Ok(vec![0.0; self.config.embedding_dimensions])
    }

    /// Get the underlying configuration.
    pub fn config(&self) -> &LocalAIConfig {
        &self.config
    }
}

