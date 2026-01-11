#![allow(missing_docs)]
//! Type definitions for the Local AI plugin.

use serde::{Deserialize, Serialize};

/// Parameters for text generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextGenerationParams {
    /// The prompt to generate from.
    pub prompt: String,
    /// Maximum tokens to generate.
    pub max_tokens: usize,
    /// Temperature for sampling.
    pub temperature: f32,
    /// Top-p (nucleus) sampling.
    pub top_p: f32,
    /// Stop sequences.
    pub stop_sequences: Vec<String>,
    /// Whether to use the large model.
    pub use_large_model: bool,
}

impl TextGenerationParams {
    /// Create new text generation parameters.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            max_tokens: 8192,
            temperature: 0.7,
            top_p: 0.9,
            stop_sequences: Vec::new(),
            use_large_model: false,
        }
    }

    /// Set maximum tokens.
    pub fn max_tokens(mut self, max: usize) -> Self {
        self.max_tokens = max;
        self
    }

    /// Set temperature.
    pub fn temperature(mut self, temp: f32) -> Self {
        self.temperature = temp;
        self
    }

    /// Set top-p.
    pub fn top_p(mut self, p: f32) -> Self {
        self.top_p = p;
        self
    }

    /// Add a stop sequence.
    pub fn stop(mut self, sequence: impl Into<String>) -> Self {
        self.stop_sequences.push(sequence.into());
        self
    }

    /// Use the large model.
    pub fn large(mut self) -> Self {
        self.use_large_model = true;
        self
    }
}

/// Parameters for embedding generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingParams {
    /// The text to embed.
    pub text: String,
}

impl EmbeddingParams {
    /// Create new embedding parameters.
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

/// Result of text generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextGenerationResult {
    /// The generated text.
    pub text: String,
    /// Number of tokens used.
    pub tokens_used: usize,
    /// Model used for generation.
    pub model: String,
}

/// Result of embedding generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingResult {
    /// The embedding vector.
    pub embedding: Vec<f32>,
    /// Number of dimensions.
    pub dimensions: usize,
    /// Model used for embedding.
    pub model: String,
}

/// Model specification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSpec {
    /// Model name/filename.
    pub name: String,
    /// Hugging Face repository.
    pub repo: String,
    /// Model size (e.g., "3B", "8B").
    pub size: String,
    /// Quantization method (e.g., "Q4_0").
    pub quantization: String,
    /// Context size.
    pub context_size: usize,
}







