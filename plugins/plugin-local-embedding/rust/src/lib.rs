//! elizaOS Local Embedding plugin (Rust).
//!
//! This crate provides a [`LocalEmbeddingManager`] for generating text embeddings locally
//! using ONNX models (via fastembed) and tokenization via HuggingFace tokenizers.
//!
//! # Model handlers
//!
//! - **TEXT_EMBEDDING** — generate embeddings from text
//! - **TEXT_TOKENIZER_ENCODE** — encode text to token IDs
//! - **TEXT_TOKENIZER_DECODE** — decode token IDs back to text

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Configuration for the local embedding plugin.
pub mod config;
/// Error types and result aliases.
pub mod error;
/// Request/response types and model specifications.
pub mod types;

pub use config::LocalEmbeddingConfig;
pub use error::{LocalEmbeddingError, Result};
pub use types::{
    EmbeddingModelSpec, EmbeddingParams, EmbeddingResponse, ModelSpec, ModelSpecs,
    TokenDecodeParams, TokenDecodeResponse, TokenEncodeParams, TokenEncodeResponse,
    TokenizerConfig,
};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::sync::Arc;
use tokenizers::Tokenizer;

/// Canonical elizaOS plugin name.
pub const PLUGIN_NAME: &str = "local-embedding";
/// Short, human-readable plugin description.
pub const PLUGIN_DESCRIPTION: &str =
    "Local text embedding and tokenization using ONNX models and HuggingFace tokenizers";
/// Plugin version, sourced from this crate's `Cargo.toml`.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Manager for local embedding generation and tokenization.
///
/// Wraps a [`fastembed::TextEmbedding`] model for embedding generation and a
/// [`tokenizers::Tokenizer`] for text encoding/decoding. The embedding model and
/// tokenizer files are downloaded automatically on first use if not already cached.
pub struct LocalEmbeddingManager {
    config: LocalEmbeddingConfig,
    embedding_model: Arc<TextEmbedding>,
    tokenizer: Arc<Tokenizer>,
}

impl LocalEmbeddingManager {
    /// Create a new [`LocalEmbeddingManager`] with the given configuration.
    ///
    /// This initializes the embedding model and tokenizer. Model files are
    /// downloaded automatically on first use if not already cached.
    pub fn new(config: LocalEmbeddingConfig) -> Result<Self> {
        tracing::info!("Initializing local embedding manager");

        let embedding_model = Self::load_embedding_model(&config)?;
        let tokenizer = Self::load_tokenizer(&config)?;

        tracing::info!("Local embedding manager initialized successfully");

        Ok(Self {
            config,
            embedding_model: Arc::new(embedding_model),
            tokenizer: Arc::new(tokenizer),
        })
    }

    /// Generate an embedding vector for the given text.
    ///
    /// Returns a zero vector when `params.text` is empty.
    pub fn generate_embedding(&self, params: EmbeddingParams) -> Result<EmbeddingResponse> {
        if params.text.is_empty() {
            tracing::debug!("Empty text input, returning zero vector");
            return Ok(EmbeddingResponse {
                embedding: vec![0.0; self.config.embedding_dimensions()],
                dimensions: self.config.embedding_dimensions(),
            });
        }

        tracing::info!(text_length = params.text.len(), "Generating embedding");

        let embeddings = self
            .embedding_model
            .embed(vec![params.text], None)
            .map_err(|e| LocalEmbeddingError::embedding(e.to_string()))?;

        let embedding = embeddings
            .into_iter()
            .next()
            .ok_or_else(|| LocalEmbeddingError::embedding("No embedding returned from model"))?;

        let normalized = Self::normalize_embedding(embedding);
        let dimensions = normalized.len();

        tracing::info!(dimensions, "Embedding generated successfully");

        Ok(EmbeddingResponse {
            embedding: normalized,
            dimensions,
        })
    }

    /// Encode text into a sequence of token IDs.
    pub fn encode_text(&self, params: TokenEncodeParams) -> Result<TokenEncodeResponse> {
        tracing::info!(text_length = params.text.len(), "Encoding text to tokens");

        let encoding = self
            .tokenizer
            .encode(params.text.as_str(), true)
            .map_err(|e| LocalEmbeddingError::tokenization(format!("Encoding failed: {e}")))?;

        let tokens: Vec<u32> = encoding.get_ids().to_vec();
        tracing::info!(token_count = tokens.len(), "Text encoded successfully");

        Ok(TokenEncodeResponse { tokens })
    }

    /// Decode a sequence of token IDs back into text.
    pub fn decode_tokens(&self, params: TokenDecodeParams) -> Result<TokenDecodeResponse> {
        tracing::info!(token_count = params.tokens.len(), "Decoding tokens to text");

        let text = self
            .tokenizer
            .decode(&params.tokens, true)
            .map_err(|e| LocalEmbeddingError::tokenization(format!("Decoding failed: {e}")))?;

        tracing::info!(text_length = text.len(), "Tokens decoded successfully");

        Ok(TokenDecodeResponse { text })
    }

    /// Access the underlying configuration.
    pub fn config(&self) -> &LocalEmbeddingConfig {
        &self.config
    }

    // ---- Private helpers ----

    fn load_embedding_model(config: &LocalEmbeddingConfig) -> Result<TextEmbedding> {
        tracing::info!(model = %config.embedding_model(), "Loading embedding model");

        let options = InitOptions {
            model_name: EmbeddingModel::BGESmallENV15,
            show_download_progress: true,
            ..Default::default()
        };

        TextEmbedding::try_new(options)
            .map_err(|e| LocalEmbeddingError::model_load(e.to_string()))
    }

    fn load_tokenizer(config: &LocalEmbeddingConfig) -> Result<Tokenizer> {
        tracing::info!(tokenizer = %config.tokenizer_name(), "Loading tokenizer");

        Tokenizer::from_pretrained(config.tokenizer_name(), None)
            .map_err(|e| LocalEmbeddingError::tokenization(format!("Failed to load tokenizer: {e}")))
    }

    /// L2 (Euclidean) normalization of an embedding vector.
    ///
    /// Returns the original vector if its norm is zero.
    fn normalize_embedding(embedding: Vec<f32>) -> Vec<f32> {
        let square_sum: f32 = embedding.iter().map(|v| v * v).sum();
        let norm = square_sum.sqrt();

        if norm == 0.0 {
            return embedding;
        }

        embedding.into_iter().map(|v| v / norm).collect()
    }
}

/// Create a [`LocalEmbeddingManager`] using environment-based configuration.
///
/// Loads [`LocalEmbeddingConfig`] via [`LocalEmbeddingConfig::from_env`] and constructs
/// a manager with the resulting settings.
pub fn create_manager_from_env() -> Result<LocalEmbeddingManager> {
    let config = LocalEmbeddingConfig::from_env()?;
    LocalEmbeddingManager::new(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_embedding_3_4_vector() {
        let embedding = vec![3.0, 4.0];
        let normalized = LocalEmbeddingManager::normalize_embedding(embedding);
        // 3/5 = 0.6, 4/5 = 0.8
        assert!((normalized[0] - 0.6).abs() < 1e-6);
        assert!((normalized[1] - 0.8).abs() < 1e-6);
        // L2 norm should be ~1.0
        let l2: f32 = normalized.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((l2 - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_normalize_zero_vector() {
        let embedding = vec![0.0, 0.0, 0.0];
        let normalized = LocalEmbeddingManager::normalize_embedding(embedding);
        assert!(normalized.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn test_normalize_single_dimension() {
        let embedding = vec![5.0];
        let normalized = LocalEmbeddingManager::normalize_embedding(embedding);
        assert!((normalized[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_normalize_preserves_direction() {
        let embedding = vec![1.0, 2.0, 3.0];
        let normalized = LocalEmbeddingManager::normalize_embedding(embedding);
        // Ratios between components should be preserved
        let ratio_01 = normalized[1] / normalized[0];
        assert!((ratio_01 - 2.0).abs() < 1e-6);
        let ratio_02 = normalized[2] / normalized[0];
        assert!((ratio_02 - 3.0).abs() < 1e-6);
    }

    #[test]
    fn test_normalize_negative_values() {
        let embedding = vec![-3.0, 4.0];
        let normalized = LocalEmbeddingManager::normalize_embedding(embedding);
        assert!((normalized[0] - (-0.6)).abs() < 1e-6);
        assert!((normalized[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn test_plugin_constants() {
        assert_eq!(PLUGIN_NAME, "local-embedding");
        assert!(!PLUGIN_DESCRIPTION.is_empty());
        assert!(!PLUGIN_VERSION.is_empty());
    }
}
