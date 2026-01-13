//! elizaOS Local AI Plugin - Rust Implementation
//!
//! Provides local LLM inference using GGUF models via llama.cpp bindings.
//!
//! # Features
//!
//! - `llm` - Enable actual inference with llama_cpp_rs
//! - `cuda` - Enable CUDA GPU acceleration
//! - `metal` - Enable Metal GPU acceleration (macOS)
//!
//! # Example
//!
//! ```no_run
//! use elizaos_plugin_local_ai::{LocalAIPlugin, LocalAIConfig, TextGenerationParams};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let plugin = LocalAIPlugin::from_env()?;
//!     let response = plugin.generate_text("Hello, world!").await?;
//!     println!("{}", response);
//!     Ok(())
//! }
//! ```

#![allow(missing_docs)]

pub mod error;
pub mod types;
pub mod xml_parser;

pub use error::{LocalAIError, Result};
pub use types::*;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result as AnyhowResult;
use tokio::sync::Mutex;

/// Configuration for the Local AI plugin.
#[derive(Debug, Clone)]
pub struct LocalAIConfig {
    /// Directory containing GGUF model files.
    pub models_dir: PathBuf,
    /// Cache directory for temporary files.
    pub cache_dir: PathBuf,
    /// Filename of the small model.
    pub small_model: String,
    /// Filename of the large model.
    pub large_model: String,
    /// Filename of the embedding model.
    pub embedding_model: String,
    /// Embedding vector dimensions.
    pub embedding_dimensions: usize,
    /// Number of layers to offload to GPU.
    pub gpu_layers: u32,
    /// Context window size.
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
            small_model: "Qwen3-4B-Q4_K_M.gguf".to_string(),
            large_model: "Qwen3-4B-Q4_K_M.gguf".to_string(),
            embedding_model: "bge-small-en-v1.5.Q4_K_M.gguf".to_string(),
            embedding_dimensions: 384,
            gpu_layers: 0,
            context_size: 8192,
        }
    }
}

impl LocalAIConfig {
    /// Create a new configuration with the specified models directory.
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

    /// Set the number of GPU layers to offload.
    pub fn gpu_layers(mut self, layers: u32) -> Self {
        self.gpu_layers = layers;
        self
    }

    /// Set the context window size.
    pub fn context_size(mut self, size: usize) -> Self {
        self.context_size = size;
        self
    }
}

// ============================================================================
// LLM Feature Implementation
// ============================================================================

#[cfg(feature = "llm")]
mod llm_impl {
    use super::*;
    use llama_cpp_rs::{
        options::{ModelOptions, PredictOptions},
        LLama,
    };

    /// Internal model holder for lazy initialization.
    pub struct ModelHolder {
        pub model: LLama,
        pub model_name: String,
    }

    impl ModelHolder {
        pub fn load(
            path: &std::path::Path,
            config: &LocalAIConfig,
            embeddings: bool,
        ) -> Result<Self> {
            let model_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            tracing::info!("Loading model: {}", path.display());

            let options = ModelOptions {
                n_gpu_layers: config.gpu_layers as i32,
                context_size: config.context_size as i32,
                embeddings,
                ..Default::default()
            };

            let model_path = path.to_string_lossy().to_string();
            let model = LLama::new(model_path, &options)
                .map_err(|e| LocalAIError::ModelLoadError(e.to_string()))?;

            tracing::info!("Model loaded successfully: {}", model_name);

            Ok(Self { model, model_name })
        }

        pub fn generate(&self, params: &TextGenerationParams) -> Result<TextGenerationResult> {
            let predict_options = PredictOptions {
                tokens: params.max_tokens as i32,
                temperature: params.temperature,
                top_p: params.top_p,
                stop_prompts: params.stop_sequences.clone(),
                ..Default::default()
            };

            let result = self
                .model
                .predict(params.prompt.clone(), predict_options)
                .map_err(|e| LocalAIError::InferenceError(e.to_string()))?;

            Ok(TextGenerationResult {
                text: result,
                tokens_used: 0, // llama_cpp_rs doesn't expose token count directly
                model: self.model_name.clone(),
            })
        }

        pub fn embed(&self, text: &str) -> Result<Vec<f32>> {
            let mut predict_options = PredictOptions::default();
            self.model
                .embeddings(text.to_string(), &mut predict_options)
                .map_err(|e| LocalAIError::InferenceError(e.to_string()))
        }
    }
}

#[cfg(not(feature = "llm"))]
mod llm_impl {
    use super::*;

    /// Placeholder model holder when LLM feature is disabled.
    pub struct ModelHolder {
        pub model_name: String,
    }

    impl ModelHolder {
        pub fn load(
            path: &std::path::Path,
            _config: &LocalAIConfig,
            _embeddings: bool,
        ) -> Result<Self> {
            let model_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            // Just verify the model file exists
            if !path.exists() {
                return Err(LocalAIError::ModelNotFound(path.display().to_string()));
            }

            tracing::warn!(
                "LLM feature not enabled. Model path validated: {} (enable 'llm' feature for actual inference)",
                path.display()
            );

            Ok(Self { model_name })
        }

        pub fn generate(&self, params: &TextGenerationParams) -> Result<TextGenerationResult> {
            let _ = params;
            Err(LocalAIError::ConfigError(format!(
                "Local inference is not available because the `llm` feature is disabled (model: {}). \
Enable it with Cargo features: `elizaos-plugin-local-ai = {{ ..., features = [\"llm\"] }}`",
                self.model_name
            )))
        }

        pub fn embed(&self, _text: &str) -> Result<Vec<f32>> {
            Err(LocalAIError::ConfigError(format!(
                "Embeddings are not available because the `llm` feature is disabled (model: {}). \
Enable it with Cargo features: `elizaos-plugin-local-ai = {{ ..., features = [\"llm\"] }}`",
                self.model_name
            )))
        }
    }
}

use llm_impl::ModelHolder;

// ============================================================================
// LocalAIPlugin
// ============================================================================

/// The main Local AI plugin struct.
///
/// Manages loading and inference with local GGUF models.
pub struct LocalAIPlugin {
    config: LocalAIConfig,
    small_model: Arc<Mutex<Option<ModelHolder>>>,
    large_model: Arc<Mutex<Option<ModelHolder>>>,
    embedding_model: Arc<Mutex<Option<ModelHolder>>>,
}

impl LocalAIPlugin {
    /// Create a new plugin with the given configuration.
    pub fn new(config: LocalAIConfig) -> Result<Self> {
        std::fs::create_dir_all(&config.models_dir)
            .map_err(|e| LocalAIError::IoError(e.to_string()))?;
        std::fs::create_dir_all(&config.cache_dir)
            .map_err(|e| LocalAIError::IoError(e.to_string()))?;

        Ok(Self {
            config,
            small_model: Arc::new(Mutex::new(None)),
            large_model: Arc::new(Mutex::new(None)),
            embedding_model: Arc::new(Mutex::new(None)),
        })
    }

    /// Create a plugin from environment variables.
    ///
    /// Reads the following environment variables:
    /// - `MODELS_DIR` - Directory containing model files
    /// - `CACHE_DIR` - Cache directory
    /// - `LOCAL_SMALL_MODEL` - Small model filename
    /// - `LOCAL_LARGE_MODEL` - Large model filename
    /// - `LOCAL_EMBEDDING_MODEL` - Embedding model filename
    /// - `LOCAL_EMBEDDING_DIMENSIONS` - Embedding vector dimensions
    /// - `GPU_LAYERS` - Number of layers to offload to GPU
    /// - `CONTEXT_SIZE` - Context window size
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

        if let Ok(layers) = std::env::var("GPU_LAYERS") {
            config.gpu_layers = layers.parse().unwrap_or(0);
        }

        if let Ok(size) = std::env::var("CONTEXT_SIZE") {
            config.context_size = size.parse().unwrap_or(8192);
        }

        Self::new(config).map_err(|e| anyhow::anyhow!("Failed to create Local AI plugin: {}", e))
    }

    /// Get a reference to the configuration.
    pub fn config(&self) -> &LocalAIConfig {
        &self.config
    }

    /// Generate text using a simple prompt.
    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        let result = self.generate_text_with_params(&params).await?;
        Ok(result.text)
    }

    /// Generate text with full parameters.
    pub async fn generate_text_with_params(
        &self,
        params: &TextGenerationParams,
    ) -> Result<TextGenerationResult> {
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

        // Get or load the appropriate model
        let model_mutex = if params.use_large_model {
            &self.large_model
        } else {
            &self.small_model
        };

        let mut model_guard = model_mutex.lock().await;

        // Lazy load the model if not already loaded
        if model_guard.is_none() {
            let holder = ModelHolder::load(&model_path, &self.config, false)?;
            *model_guard = Some(holder);
        }

        let holder = model_guard.as_ref().unwrap();
        holder.generate(params)
    }

    /// Create an embedding for the given text.
    ///
    /// Note: Embedding support requires additional implementation with
    /// a dedicated embedding model. Currently returns zeros.
    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.create_embedding_with_params(&params).await
    }

    /// Create an embedding with full parameters.
    pub async fn create_embedding_with_params(&self, params: &EmbeddingParams) -> Result<Vec<f32>> {
        let model_path = self.config.models_dir.join(&self.config.embedding_model);

        if !model_path.exists() {
            return Err(LocalAIError::ModelNotFound(
                model_path.display().to_string(),
            ));
        }

        let mut model_guard = self.embedding_model.lock().await;

        // Lazy load embedding model if not already loaded
        if model_guard.is_none() {
            let holder = ModelHolder::load(&model_path, &self.config, true)?;
            *model_guard = Some(holder);
        }

        let holder = model_guard.as_ref().unwrap();
        let embedding = holder.embed(&params.text)?;

        if embedding.len() != self.config.embedding_dimensions {
            tracing::warn!(
                "Embedding dimensions mismatch: config={} model={}",
                self.config.embedding_dimensions,
                embedding.len()
            );
        }

        Ok(embedding)
    }

    /// Check if the LLM feature is enabled.
    pub fn is_llm_enabled() -> bool {
        cfg!(feature = "llm")
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_config_defaults() {
        let config = LocalAIConfig::default();
        assert!(!config.small_model.is_empty());
        assert!(!config.large_model.is_empty());
        assert_eq!(config.embedding_dimensions, 384);
        assert_eq!(config.gpu_layers, 0);
        assert_eq!(config.context_size, 8192);
    }

    #[test]
    fn test_config_builder() {
        let config = LocalAIConfig::new("/tmp/models")
            .small_model("test-small.gguf")
            .large_model("test-large.gguf")
            .gpu_layers(10)
            .context_size(4096);

        assert_eq!(config.models_dir, PathBuf::from("/tmp/models"));
        assert_eq!(config.small_model, "test-small.gguf");
        assert_eq!(config.large_model, "test-large.gguf");
        assert_eq!(config.gpu_layers, 10);
        assert_eq!(config.context_size, 4096);
    }

    #[test]
    fn test_text_generation_params() {
        let params = TextGenerationParams::new("Hello")
            .max_tokens(100)
            .temperature(0.5)
            .top_p(0.8)
            .stop("</answer>")
            .large();

        assert_eq!(params.prompt, "Hello");
        assert_eq!(params.max_tokens, 100);
        assert_eq!(params.temperature, 0.5);
        assert_eq!(params.top_p, 0.8);
        assert!(params.stop_sequences.contains(&"</answer>".to_string()));
        assert!(params.use_large_model);
    }

    #[tokio::test]
    async fn test_plugin_creation() {
        let dir = tempdir().unwrap();
        let config = LocalAIConfig::new(dir.path().join("models"));
        let plugin = LocalAIPlugin::new(config);

        assert!(plugin.is_ok());
    }

    #[tokio::test]
    async fn test_model_not_found() {
        let dir = tempdir().unwrap();
        let config = LocalAIConfig::new(dir.path().join("models")).small_model("nonexistent.gguf");
        let plugin = LocalAIPlugin::new(config).unwrap();

        let result = plugin.generate_text("test").await;
        assert!(result.is_err());

        match result {
            Err(LocalAIError::ModelNotFound(_)) => {}
            _ => panic!("Expected ModelNotFound error"),
        }
    }

    #[test]
    fn test_llm_feature_flag() {
        // This test verifies the feature flag is correctly detected
        let enabled = LocalAIPlugin::is_llm_enabled();

        #[cfg(feature = "llm")]
        assert!(enabled);

        #[cfg(not(feature = "llm"))]
        assert!(!enabled);
    }
}
