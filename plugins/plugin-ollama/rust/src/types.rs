//! Core types for the Ollama API.
//!
//! All types are strongly typed with explicit field requirements.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Parameters for text generation.
#[derive(Debug, Clone, Default)]
pub struct TextGenerationParams {
    /// The prompt to generate from.
    pub prompt: String,
    /// Optional system prompt.
    pub system: Option<String>,
    /// Temperature (0.0 to 2.0).
    pub temperature: Option<f32>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// Top-p sampling (0.0 to 1.0).
    pub top_p: Option<f32>,
    /// Top-k sampling.
    pub top_k: Option<u32>,
    /// Stop sequences.
    pub stop: Option<Vec<String>>,
}

impl TextGenerationParams {
    /// Create new params with a prompt.
    pub fn new<S: Into<String>>(prompt: S) -> Self {
        Self {
            prompt: prompt.into(),
            ..Default::default()
        }
    }

    /// Set the system prompt.
    pub fn with_system<S: Into<String>>(mut self, system: S) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Set temperature.
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }

    /// Set max tokens.
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    /// Set top_p.
    pub fn with_top_p(mut self, top_p: f32) -> Self {
        self.top_p = Some(top_p);
        self
    }
}

/// Response from text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationResponse {
    /// The generated text.
    pub text: String,
    /// Model used for generation.
    pub model: String,
    /// Whether generation is complete.
    pub done: bool,
}

/// Parameters for JSON object generation.
#[derive(Debug, Clone, Default)]
pub struct ObjectGenerationParams {
    /// The prompt describing the object to generate.
    pub prompt: String,
    /// Optional system prompt.
    pub system: Option<String>,
    /// Temperature for generation.
    pub temperature: Option<f32>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// JSON Schema for the expected output (optional).
    pub schema: Option<serde_json::Value>,
}

impl ObjectGenerationParams {
    /// Create new params with a prompt.
    pub fn new<S: Into<String>>(prompt: S) -> Self {
        Self {
            prompt: prompt.into(),
            temperature: Some(0.2), // Lower default for structured output
            ..Default::default()
        }
    }

    /// Set the system prompt.
    pub fn with_system<S: Into<String>>(mut self, system: S) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Set a JSON schema.
    pub fn with_schema(mut self, schema: serde_json::Value) -> Self {
        self.schema = Some(schema);
        self
    }

    /// Set temperature.
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }
}

/// Response from object generation.
#[derive(Debug, Clone)]
pub struct ObjectGenerationResponse {
    /// The generated JSON object.
    pub object: serde_json::Value,
    /// Model used for generation.
    pub model: String,
}

/// Parameters for embedding generation.
#[derive(Debug, Clone)]
pub struct EmbeddingParams {
    /// The text to embed.
    pub text: String,
}

impl EmbeddingParams {
    /// Create new params with text.
    pub fn new<S: Into<String>>(text: S) -> Self {
        Self { text: text.into() }
    }
}

/// Response from embedding generation.
#[derive(Debug, Clone)]
pub struct EmbeddingResponse {
    /// The embedding vector.
    pub embedding: Vec<f64>,
    /// Model used for embedding.
    pub model: String,
}

/// Model information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    /// Model name.
    pub name: String,
    /// Model size in bytes.
    pub size: u64,
    /// Modified timestamp.
    pub modified_at: String,
    /// Model digest.
    #[serde(default)]
    pub digest: Option<String>,
}

/// Request body for the Ollama generate API.
#[derive(Debug, Serialize)]
pub(crate) struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<HashMap<String, serde_json::Value>>,
}

/// Response body from the Ollama generate API.
#[derive(Debug, Deserialize)]
pub(crate) struct GenerateResponse {
    pub model: String,
    pub created_at: String,
    pub response: String,
    pub done: bool,
    #[serde(default)]
    pub context: Option<Vec<i64>>,
    #[serde(default)]
    pub total_duration: Option<u64>,
    #[serde(default)]
    pub load_duration: Option<u64>,
    #[serde(default)]
    pub prompt_eval_count: Option<u32>,
    #[serde(default)]
    pub prompt_eval_duration: Option<u64>,
    #[serde(default)]
    pub eval_count: Option<u32>,
    #[serde(default)]
    pub eval_duration: Option<u64>,
}

/// Request body for the Ollama embeddings API.
#[derive(Debug, Serialize)]
pub(crate) struct EmbeddingsRequest {
    pub model: String,
    pub prompt: String,
}

/// Response body from the Ollama embeddings API.
#[derive(Debug, Deserialize)]
pub(crate) struct EmbeddingsResponse {
    pub embedding: Vec<f64>,
}

/// Response body from the Ollama tags API.
#[derive(Debug, Deserialize)]
pub(crate) struct TagsResponse {
    pub models: Vec<ModelInfo>,
}

/// Request to show model info.
#[derive(Debug, Serialize)]
pub(crate) struct ShowRequest {
    pub model: String,
}

/// Request to pull a model.
#[derive(Debug, Serialize)]
pub(crate) struct PullRequest {
    pub model: String,
    pub stream: bool,
}

