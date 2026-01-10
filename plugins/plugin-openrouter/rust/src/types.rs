//! Core types for the OpenRouter API.
//!
//! All types are strongly typed with explicit field requirements.

use serde::{Deserialize, Serialize};

/// Token usage information from API response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Number of tokens in the prompt.
    pub prompt_tokens: u32,
    /// Number of tokens in the completion.
    pub completion_tokens: u32,
    /// Total tokens used.
    pub total_tokens: u32,
}

impl TokenUsage {
    /// Get total tokens used.
    pub fn total(&self) -> u32 {
        self.total_tokens
    }
}

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
    /// Frequency penalty.
    pub frequency_penalty: Option<f32>,
    /// Presence penalty.
    pub presence_penalty: Option<f32>,
    /// Stop sequences.
    pub stop: Option<Vec<String>>,
}

impl TextGenerationParams {
    /// Create new params with a prompt.
    pub fn new<S: Into<String>>(prompt: S) -> Self {
        Self {
            prompt: prompt.into(),
            temperature: Some(0.7),
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
    /// Token usage information.
    pub usage: Option<TokenUsage>,
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
    /// Token usage information.
    pub usage: Option<TokenUsage>,
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
    /// Model ID.
    pub id: String,
    /// Model name.
    #[serde(default)]
    pub name: Option<String>,
    /// Context length.
    #[serde(default)]
    pub context_length: Option<u32>,
    /// Pricing information.
    #[serde(default)]
    pub pricing: Option<ModelPricing>,
}

/// Model pricing information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPricing {
    /// Price per prompt token.
    #[serde(default)]
    pub prompt: Option<f64>,
    /// Price per completion token.
    #[serde(default)]
    pub completion: Option<f64>,
}

/// Chat message role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// System message.
    System,
    /// User message.
    User,
    /// Assistant message.
    Assistant,
}

/// Chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Message role.
    pub role: Role,
    /// Message content.
    pub content: String,
}

impl ChatMessage {
    /// Create a system message.
    pub fn system<S: Into<String>>(content: S) -> Self {
        Self {
            role: Role::System,
            content: content.into(),
        }
    }

    /// Create a user message.
    pub fn user<S: Into<String>>(content: S) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
        }
    }

    /// Create an assistant message.
    pub fn assistant<S: Into<String>>(content: S) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
        }
    }
}

/// Request body for chat completions.
#[derive(Debug, Serialize)]
pub(crate) struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<ResponseFormat>,
}

/// Response format specification.
#[derive(Debug, Serialize)]
pub(crate) struct ResponseFormat {
    #[serde(rename = "type")]
    pub format_type: String,
}

/// Chat completion choice.
#[derive(Debug, Deserialize)]
pub(crate) struct ChatCompletionChoice {
    pub index: u32,
    pub message: ChatMessage,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

/// Response from chat completions.
#[derive(Debug, Deserialize)]
pub(crate) struct ChatCompletionResponse {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<ChatCompletionChoice>,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

/// Request body for embeddings.
#[derive(Debug, Serialize)]
pub(crate) struct EmbeddingsRequest {
    pub model: String,
    pub input: String,
}

/// Embedding data in response.
#[derive(Debug, Deserialize)]
pub(crate) struct EmbeddingData {
    pub object: String,
    pub embedding: Vec<f64>,
    pub index: u32,
}

/// Response from embeddings API.
#[derive(Debug, Deserialize)]
pub(crate) struct EmbeddingsResponseBody {
    pub object: String,
    pub data: Vec<EmbeddingData>,
    pub model: String,
    #[serde(default)]
    pub usage: Option<TokenUsage>,
}

/// Models list response.
#[derive(Debug, Deserialize)]
pub(crate) struct ModelsResponse {
    pub data: Vec<ModelInfo>,
}

