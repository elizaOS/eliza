#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextGenerationParams {
    pub prompt: String,
    pub max_tokens: usize,
    pub temperature: f32,
    pub top_p: f32,
    pub stop_sequences: Vec<String>,
    pub use_large_model: bool,
}

impl TextGenerationParams {
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

    pub fn max_tokens(mut self, max: usize) -> Self {
        self.max_tokens = max;
        self
    }

    pub fn temperature(mut self, temp: f32) -> Self {
        self.temperature = temp;
        self
    }

    pub fn top_p(mut self, p: f32) -> Self {
        self.top_p = p;
        self
    }

    pub fn stop(mut self, sequence: impl Into<String>) -> Self {
        self.stop_sequences.push(sequence.into());
        self
    }

    pub fn large(mut self) -> Self {
        self.use_large_model = true;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingParams {
    pub text: String,
}

impl EmbeddingParams {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextGenerationResult {
    pub text: String,
    pub tokens_used: usize,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingResult {
    pub embedding: Vec<f32>,
    pub dimensions: usize,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSpec {
    pub name: String,
    pub repo: String,
    pub size: String,
    pub quantization: String,
    pub context_size: usize,
}
