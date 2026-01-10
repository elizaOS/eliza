//! Vercel AI Gateway Plugin Types
//!
//! Strong types with Serde validation for all API interactions.

use serde::{Deserialize, Serialize};

// ============================================================================
// Enums
// ============================================================================

/// Image sizes for generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageSize {
    /// 256x256 pixels
    #[serde(rename = "256x256")]
    Size256,
    /// 512x512 pixels
    #[serde(rename = "512x512")]
    Size512,
    /// 1024x1024 pixels (default)
    #[serde(rename = "1024x1024")]
    Size1024,
    /// 1792x1024 pixels (landscape)
    #[serde(rename = "1792x1024")]
    Size1792x1024,
    /// 1024x1792 pixels (portrait)
    #[serde(rename = "1024x1792")]
    Size1024x1792,
}

impl Default for ImageSize {
    fn default() -> Self {
        Self::Size1024
    }
}

/// Image quality options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageQuality {
    /// Standard quality (default)
    Standard,
    /// HD quality
    Hd,
}

impl Default for ImageQuality {
    fn default() -> Self {
        Self::Standard
    }
}

/// Image style options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageStyle {
    /// Vivid style (default)
    Vivid,
    /// Natural style
    Natural,
}

impl Default for ImageStyle {
    fn default() -> Self {
        Self::Vivid
    }
}

// ============================================================================
// Configuration
// ============================================================================

/// Gateway client configuration.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    /// API key for authentication.
    pub api_key: String,
    /// Base URL for API requests.
    pub base_url: String,
    /// Model for embeddings.
    pub embedding_model: String,
    /// Embedding dimensions.
    pub embedding_dimensions: usize,
    /// Model for text generation (large).
    pub large_model: String,
    /// Model for text generation (small).
    pub small_model: String,
    /// Model for image generation.
    pub image_model: String,
    /// Request timeout in seconds.
    pub timeout_secs: u64,
}

impl GatewayConfig {
    /// Create a new configuration with required API key.
    pub fn new(api_key: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: "https://ai-gateway.vercel.sh/v1".to_string(),
            embedding_model: "text-embedding-3-small".to_string(),
            embedding_dimensions: 1536,
            large_model: "gpt-5".to_string(),
            small_model: "gpt-5-mini".to_string(),
            image_model: "dall-e-3".to_string(),
            timeout_secs: 60,
        }
    }

    /// Set the base URL.
    pub fn base_url(mut self, url: &str) -> Self {
        self.base_url = url.to_string();
        self
    }

    /// Set the large model.
    pub fn large_model(mut self, model: &str) -> Self {
        self.large_model = model.to_string();
        self
    }

    /// Set the small model.
    pub fn small_model(mut self, model: &str) -> Self {
        self.small_model = model.to_string();
        self
    }

    /// Set the embedding model.
    pub fn embedding_model(mut self, model: &str) -> Self {
        self.embedding_model = model.to_string();
        self
    }

    /// Set embedding dimensions.
    pub fn embedding_dimensions(mut self, dims: usize) -> Self {
        self.embedding_dimensions = dims;
        self
    }
}

// ============================================================================
// Request Parameters
// ============================================================================

/// Parameters for text generation.
#[derive(Debug, Clone, Serialize)]
pub struct TextGenerationParams {
    /// The prompt for generation.
    pub prompt: String,
    /// Optional system message.
    pub system: Option<String>,
    /// Model to use.
    pub model: Option<String>,
    /// Sampling temperature (0.0-2.0).
    pub temperature: Option<f32>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// Frequency penalty (-2.0-2.0).
    pub frequency_penalty: Option<f32>,
    /// Presence penalty (-2.0-2.0).
    pub presence_penalty: Option<f32>,
    /// Stop sequences.
    pub stop: Option<Vec<String>>,
}

impl TextGenerationParams {
    /// Create new text generation parameters.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            system: None,
            model: None,
            temperature: None,
            max_tokens: None,
            frequency_penalty: None,
            presence_penalty: None,
            stop: None,
        }
    }

    /// Set system message.
    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Set model.
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Set temperature.
    pub fn temperature(mut self, temp: f32) -> Self {
        self.temperature = Some(temp);
        self
    }

    /// Set max tokens.
    pub fn max_tokens(mut self, max: u32) -> Self {
        self.max_tokens = Some(max);
        self
    }
}

/// Parameters for embedding generation.
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingParams {
    /// The text to embed.
    pub text: String,
    /// Model to use.
    pub model: Option<String>,
    /// Embedding dimensions.
    pub dimensions: Option<usize>,
}

impl EmbeddingParams {
    /// Create new embedding parameters.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            model: None,
            dimensions: None,
        }
    }
}

/// Parameters for image generation.
#[derive(Debug, Clone, Serialize)]
pub struct ImageGenerationParams {
    /// The prompt for image generation.
    pub prompt: String,
    /// Model to use.
    pub model: Option<String>,
    /// Number of images to generate.
    pub n: Option<u32>,
    /// Image size.
    pub size: Option<ImageSize>,
    /// Image quality.
    pub quality: Option<ImageQuality>,
    /// Image style.
    pub style: Option<ImageStyle>,
}

impl ImageGenerationParams {
    /// Create new image generation parameters.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            model: None,
            n: None,
            size: None,
            quality: None,
            style: None,
        }
    }
}

/// Parameters for image description.
#[derive(Debug, Clone)]
pub struct ImageDescriptionParams {
    /// URL of the image to describe.
    pub image_url: String,
    /// Model to use.
    pub model: Option<String>,
    /// Prompt for the description.
    pub prompt: Option<String>,
    /// Maximum tokens for description.
    pub max_tokens: Option<u32>,
}

impl ImageDescriptionParams {
    /// Create new image description parameters.
    pub fn new(image_url: impl Into<String>) -> Self {
        Self {
            image_url: image_url.into(),
            model: None,
            prompt: None,
            max_tokens: None,
        }
    }
}

// ============================================================================
// API Responses
// ============================================================================

/// Chat message structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Role of the message sender.
    pub role: String,
    /// Message content.
    pub content: Option<String>,
}

/// Chat completion response choice.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionChoice {
    /// Index of the choice.
    pub index: u32,
    /// The message.
    pub message: ChatMessage,
    /// Finish reason.
    pub finish_reason: Option<String>,
}

/// Chat completion response.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionResponse {
    /// Response ID.
    pub id: String,
    /// Object type.
    pub object: String,
    /// Creation timestamp.
    pub created: u64,
    /// Model used.
    pub model: String,
    /// Completion choices.
    pub choices: Vec<ChatCompletionChoice>,
}

/// Embedding data item.
#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingData {
    /// The embedding vector.
    pub embedding: Vec<f32>,
    /// Index of the embedding.
    pub index: u32,
}

/// Embedding response.
#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingResponse {
    /// Embedding data.
    pub data: Vec<EmbeddingData>,
    /// Model used.
    pub model: String,
}

/// Image generation data item.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageData {
    /// URL of the generated image.
    pub url: Option<String>,
    /// Revised prompt used.
    pub revised_prompt: Option<String>,
}

/// Image generation response.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageGenerationResponse {
    /// Creation timestamp.
    pub created: u64,
    /// Image data.
    pub data: Vec<ImageData>,
}

/// Result from image generation.
#[derive(Debug, Clone)]
pub struct ImageGenerationResult {
    /// URL of the generated image.
    pub url: Option<String>,
    /// Revised prompt.
    pub revised_prompt: Option<String>,
}

/// Result from image description.
#[derive(Debug, Clone)]
pub struct ImageDescriptionResult {
    /// Title of the image.
    pub title: String,
    /// Description of the image.
    pub description: String,
}

