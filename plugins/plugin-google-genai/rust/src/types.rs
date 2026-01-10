//! Core types for the Google GenAI API.
//!
//! All types are strongly typed with explicit field requirements.

use serde::{Deserialize, Serialize};

/// Token usage information from API response.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// Number of tokens in the prompt.
    #[serde(default)]
    pub prompt_token_count: u32,
    /// Number of tokens in the candidates.
    #[serde(default)]
    pub candidates_token_count: u32,
    /// Total number of tokens.
    #[serde(default)]
    pub total_token_count: u32,
}

impl TokenUsage {
    /// Get total tokens used.
    pub fn total_tokens(&self) -> u32 {
        self.total_token_count
    }
}

/// Parameters for text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationParams {
    /// The prompt to generate from.
    pub prompt: String,
    /// Optional system prompt.
    pub system: Option<String>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// Temperature (0.0 to 2.0).
    pub temperature: Option<f32>,
    /// Top-K sampling.
    pub top_k: Option<u32>,
    /// Top-P sampling (0.0 to 1.0).
    pub top_p: Option<f32>,
    /// Stop sequences.
    pub stop_sequences: Option<Vec<String>>,
}

impl Default for TextGenerationParams {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            system: None,
            max_tokens: None,
            temperature: Some(0.7),
            top_k: Some(40),
            top_p: Some(0.95),
            stop_sequences: None,
        }
    }
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

    /// Set max tokens.
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    /// Set temperature.
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }
}

/// Response from text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationResponse {
    /// The generated text.
    pub text: String,
    /// Token usage information.
    pub usage: TokenUsage,
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
    pub embedding: Vec<f32>,
    /// Model used for generation.
    pub model: String,
}

/// Parameters for image description.
#[derive(Debug, Clone)]
pub struct ImageDescriptionParams {
    /// URL of the image to describe.
    pub image_url: String,
    /// Optional custom prompt.
    pub prompt: Option<String>,
}

impl ImageDescriptionParams {
    /// Create new params with an image URL.
    pub fn new<S: Into<String>>(image_url: S) -> Self {
        Self {
            image_url: image_url.into(),
            prompt: None,
        }
    }

    /// Set a custom prompt.
    pub fn with_prompt<S: Into<String>>(mut self, prompt: S) -> Self {
        self.prompt = Some(prompt.into());
        self
    }
}

/// Response from image description.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDescriptionResponse {
    /// Title of the image.
    pub title: String,
    /// Detailed description.
    pub description: String,
}

/// Parameters for JSON object generation.
#[derive(Debug, Clone)]
pub struct ObjectGenerationParams {
    /// The prompt describing the object to generate.
    pub prompt: String,
    /// Optional system prompt.
    pub system: Option<String>,
    /// JSON Schema for the expected output (optional).
    pub schema: Option<serde_json::Value>,
    /// Temperature for generation (lower = more deterministic).
    pub temperature: Option<f32>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
}

impl Default for ObjectGenerationParams {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            system: None,
            schema: None,
            temperature: Some(0.1), // Lower default for structured output
            max_tokens: None,
        }
    }
}

impl ObjectGenerationParams {
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
    /// Token usage information.
    pub usage: TokenUsage,
    /// Model used for generation.
    pub model: String,
}

/// Request body for the Google GenAI generateContent API.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerateContentRequest {
    pub contents: Vec<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_config: Option<GenerationConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_settings: Option<Vec<SafetySetting>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_instruction: Option<Content>,
}

/// Content in a request/response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Content {
    /// Parts of the content.
    pub parts: Vec<Part>,
    /// Optional role.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// Part of content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    /// Text content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Inline data (for images).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_data: Option<InlineData>,
}

/// Inline data for images.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineData {
    /// MIME type.
    pub mime_type: String,
    /// Base64 encoded data.
    pub data: String,
}

/// Generation configuration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationConfig {
    /// Temperature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Top-K.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<u32>,
    /// Top-P.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    /// Max output tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// Stop sequences.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    /// Response MIME type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_mime_type: Option<String>,
}

/// Safety setting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetySetting {
    /// Category.
    pub category: String,
    /// Threshold.
    pub threshold: String,
}

/// Response body from the Google GenAI generateContent API.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerateContentResponse {
    pub candidates: Option<Vec<Candidate>>,
    pub usage_metadata: Option<TokenUsage>,
}

impl GenerateContentResponse {
    /// Extract text from the first candidate.
    pub fn get_text(&self) -> String {
        self.candidates
            .as_ref()
            .and_then(|c| c.first())
            .and_then(|c| c.content.as_ref())
            .map(|content| {
                content
                    .parts
                    .iter()
                    .filter_map(|p| p.text.as_ref())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    }
}

/// Candidate in response.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Content.
    pub content: Option<Content>,
    /// Finish reason.
    pub finish_reason: Option<String>,
}

/// Request body for the Google GenAI embedContent API.
#[derive(Debug, Serialize)]
pub(crate) struct EmbedContentRequest {
    pub content: Content,
}

/// Response body from the Google GenAI embedContent API.
#[derive(Debug, Deserialize)]
pub(crate) struct EmbedContentResponse {
    pub embedding: EmbeddingValue,
}

/// Embedding value.
#[derive(Debug, Deserialize)]
pub struct EmbeddingValue {
    /// Embedding values.
    pub values: Vec<f32>,
}

/// Error response from the Google GenAI API.
#[derive(Debug, Deserialize)]
pub(crate) struct ErrorResponse {
    pub error: ErrorDetail,
}

/// Error detail from the Google GenAI API.
#[derive(Debug, Deserialize)]
pub(crate) struct ErrorDetail {
    #[allow(dead_code)]
    pub code: u16,
    pub message: String,
    pub status: String,
}

