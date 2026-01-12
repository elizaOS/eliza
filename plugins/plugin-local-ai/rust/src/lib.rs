#![allow(missing_docs)]

pub mod error;
pub mod types;
pub mod xml_parser;

pub use error::{LocalAIError, Result};
pub use types::*;

use std::path::PathBuf;
use anyhow::Result as AnyhowResult;

#[derive(Debug, Clone)]
pub struct LocalAIConfig {
    pub models_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub small_model: String,
    pub large_model: String,
    pub embedding_model: String,
    pub embedding_dimensions: usize,
    pub gpu_layers: u32,
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
    pub fn new(models_dir: impl Into<PathBuf>) -> Self {
        let models_dir = models_dir.into();
        Self {
            models_dir,
            ..Default::default()
        }
    }

    pub fn small_model(mut self, model: impl Into<String>) -> Self {
        self.small_model = model.into();
        self
    }

    pub fn large_model(mut self, model: impl Into<String>) -> Self {
        self.large_model = model.into();
        self
    }

    pub fn embedding_model(mut self, model: impl Into<String>) -> Self {
        self.embedding_model = model.into();
        self
    }

    pub fn gpu_layers(mut self, layers: u32) -> Self {
        self.gpu_layers = layers;
        self
    }

    pub fn context_size(mut self, size: usize) -> Self {
        self.context_size = size;
        self
    }
}

pub struct LocalAIPlugin {
    config: LocalAIConfig,
}

impl LocalAIPlugin {
    pub fn new(config: LocalAIConfig) -> Result<Self> {
        std::fs::create_dir_all(&config.models_dir)
            .map_err(|e| LocalAIError::IoError(e.to_string()))?;
        std::fs::create_dir_all(&config.cache_dir)
            .map_err(|e| LocalAIError::IoError(e.to_string()))?;

        Ok(Self { config })
    }

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

    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        self.generate_text_with_params(&params).await
    }

    pub async fn generate_text_with_params(&self, params: &TextGenerationParams) -> Result<String> {
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

        tracing::info!(
            "Model path validated: {} (llm feature required for inference)",
            model_path.display()
        );

        Ok(format!(
            "[Mock] Response to: {}... (enable llm feature for actual inference)",
            &params.prompt[..params.prompt.len().min(50)]
        ))
    }

    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.create_embedding_with_params(&params).await
    }

    pub async fn create_embedding_with_params(&self, _params: &EmbeddingParams) -> Result<Vec<f32>> {
        let model_path = self.config.models_dir.join(&self.config.embedding_model);

        if !model_path.exists() {
            return Err(LocalAIError::ModelNotFound(
                model_path.display().to_string(),
            ));
        }

        tracing::info!(
            "Model path validated: {} (llm feature required for embeddings)",
            model_path.display()
        );

        Ok(vec![0.0; self.config.embedding_dimensions])
    }

    pub fn config(&self) -> &LocalAIConfig {
        &self.config
    }
}

