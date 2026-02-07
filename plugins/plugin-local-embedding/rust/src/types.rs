#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

/// Configuration for a tokenizer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenizerConfig {
    /// HuggingFace model/tokenizer identifier.
    pub name: String,
    /// Tokenizer type (e.g. "bert", "llama").
    #[serde(rename = "type")]
    pub tokenizer_type: String,
}

/// Specification for a language model.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelSpec {
    /// Model filename.
    pub name: String,
    /// HuggingFace repository identifier.
    pub repo: String,
    /// Human-readable model size (e.g. "3B").
    pub size: String,
    /// Quantization method (e.g. "Q4_0").
    pub quantization: String,
    /// Maximum context window in tokens.
    pub context_size: usize,
    /// Tokenizer configuration for this model.
    pub tokenizer: TokenizerConfig,
}

/// Specification for an embedding model, extending [`ModelSpec`] with a dimensions field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EmbeddingModelSpec {
    /// Model filename.
    pub name: String,
    /// HuggingFace repository identifier.
    pub repo: String,
    /// Human-readable model size.
    pub size: String,
    /// Quantization method.
    pub quantization: String,
    /// Maximum context window in tokens.
    pub context_size: usize,
    /// Output embedding dimensionality.
    pub dimensions: usize,
    /// Tokenizer configuration for this model.
    pub tokenizer: TokenizerConfig,
}

// ---- Request / response types for model handlers ----

/// Parameters for generating a text embedding.
#[derive(Debug, Clone)]
pub struct EmbeddingParams {
    /// The text to embed.
    pub text: String,
}

impl EmbeddingParams {
    /// Create new [`EmbeddingParams`].
    pub fn new<S: Into<String>>(text: S) -> Self {
        Self { text: text.into() }
    }
}

/// Response from embedding generation.
#[derive(Debug, Clone)]
pub struct EmbeddingResponse {
    /// The embedding vector.
    pub embedding: Vec<f32>,
    /// Number of dimensions in the embedding.
    pub dimensions: usize,
}

/// Parameters for encoding text to token IDs.
#[derive(Debug, Clone)]
pub struct TokenEncodeParams {
    /// The text to encode.
    pub text: String,
}

impl TokenEncodeParams {
    /// Create new [`TokenEncodeParams`].
    pub fn new<S: Into<String>>(text: S) -> Self {
        Self { text: text.into() }
    }
}

/// Response from text encoding.
#[derive(Debug, Clone)]
pub struct TokenEncodeResponse {
    /// The resulting token IDs.
    pub tokens: Vec<u32>,
}

/// Parameters for decoding token IDs back to text.
#[derive(Debug, Clone)]
pub struct TokenDecodeParams {
    /// The token IDs to decode.
    pub tokens: Vec<u32>,
}

impl TokenDecodeParams {
    /// Create new [`TokenDecodeParams`].
    pub fn new(tokens: Vec<u32>) -> Self {
        Self { tokens }
    }
}

/// Response from token decoding.
#[derive(Debug, Clone)]
pub struct TokenDecodeResponse {
    /// The decoded text.
    pub text: String,
}

/// Predefined model specifications matching the TypeScript implementation.
pub struct ModelSpecs;

impl ModelSpecs {
    /// Default embedding model specification (BGE-small-en-v1.5).
    pub fn embedding() -> EmbeddingModelSpec {
        EmbeddingModelSpec {
            name: "bge-small-en-v1.5.Q4_K_M.gguf".to_string(),
            repo: "ChristianAzinn/bge-small-en-v1.5-gguf".to_string(),
            size: "133 MB".to_string(),
            quantization: "Q4_K_M".to_string(),
            context_size: 512,
            dimensions: 384,
            tokenizer: TokenizerConfig {
                name: "BAAI/bge-small-en-v1.5".to_string(),
                tokenizer_type: "bert".to_string(),
            },
        }
    }

    /// Default small language model specification.
    pub fn small() -> ModelSpec {
        ModelSpec {
            name: "DeepHermes-3-Llama-3-3B-Preview-q4.gguf".to_string(),
            repo: "NousResearch/DeepHermes-3-Llama-3-3B-Preview-GGUF".to_string(),
            size: "3B".to_string(),
            quantization: "Q4_0".to_string(),
            context_size: 8192,
            tokenizer: TokenizerConfig {
                name: "NousResearch/DeepHermes-3-Llama-3-3B-Preview".to_string(),
                tokenizer_type: "llama".to_string(),
            },
        }
    }

    /// Default medium language model specification.
    pub fn medium() -> ModelSpec {
        ModelSpec {
            name: "DeepHermes-3-Llama-3-8B-q4.gguf".to_string(),
            repo: "NousResearch/DeepHermes-3-Llama-3-8B-Preview-GGUF".to_string(),
            size: "8B".to_string(),
            quantization: "Q4_0".to_string(),
            context_size: 8192,
            tokenizer: TokenizerConfig {
                name: "NousResearch/DeepHermes-3-Llama-3-8B-Preview".to_string(),
                tokenizer_type: "llama".to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedding_model_spec() {
        let spec = ModelSpecs::embedding();
        assert_eq!(spec.dimensions, 384);
        assert_eq!(spec.context_size, 512);
        assert_eq!(spec.tokenizer.tokenizer_type, "bert");
        assert_eq!(spec.tokenizer.name, "BAAI/bge-small-en-v1.5");
    }

    #[test]
    fn test_small_model_spec() {
        let spec = ModelSpecs::small();
        assert_eq!(spec.context_size, 8192);
        assert_eq!(spec.quantization, "Q4_0");
        assert_eq!(spec.size, "3B");
    }

    #[test]
    fn test_medium_model_spec() {
        let spec = ModelSpecs::medium();
        assert_eq!(spec.size, "8B");
        assert_eq!(spec.context_size, 8192);
    }

    #[test]
    fn test_embedding_params_new() {
        let params = EmbeddingParams::new("test text");
        assert_eq!(params.text, "test text");
    }

    #[test]
    fn test_embedding_params_from_string() {
        let params = EmbeddingParams::new(String::from("from string"));
        assert_eq!(params.text, "from string");
    }

    #[test]
    fn test_token_encode_params_new() {
        let params = TokenEncodeParams::new("hello world");
        assert_eq!(params.text, "hello world");
    }

    #[test]
    fn test_token_decode_params_new() {
        let params = TokenDecodeParams::new(vec![1, 2, 3]);
        assert_eq!(params.tokens, vec![1, 2, 3]);
    }

    #[test]
    fn test_embedding_model_spec_serialization() {
        let spec = ModelSpecs::embedding();
        let json = serde_json::to_string(&spec).expect("serialization should succeed");
        let deserialized: EmbeddingModelSpec =
            serde_json::from_str(&json).expect("deserialization should succeed");
        assert_eq!(deserialized, spec);
    }

    #[test]
    fn test_model_spec_serialization() {
        let spec = ModelSpecs::small();
        let json = serde_json::to_string(&spec).expect("serialization should succeed");
        let deserialized: ModelSpec =
            serde_json::from_str(&json).expect("deserialization should succeed");
        assert_eq!(deserialized, spec);
    }

    #[test]
    fn test_tokenizer_config_equality() {
        let a = TokenizerConfig {
            name: "test".to_string(),
            tokenizer_type: "bert".to_string(),
        };
        let b = a.clone();
        assert_eq!(a, b);
    }
}
