#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ImageSize {
    #[serde(rename = "256x256")]
    Size256,
    #[serde(rename = "512x512")]
    Size512,
    #[serde(rename = "1024x1024")]
    #[default]
    Size1024,
    #[serde(rename = "1792x1024")]
    Size1792x1024,
    #[serde(rename = "1024x1792")]
    Size1024x1792,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ImageQuality {
    #[default]
    Standard,
    Hd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ImageStyle {
    #[default]
    Vivid,
    Natural,
}

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

    pub fn base_url(mut self, url: &str) -> Self {
        self.base_url = url.to_string();
        self
    }

    /// Set the large model.
    pub fn large_model(mut self, model: &str) -> Self {
        self.large_model = model.to_string();
        self
    }

    pub fn small_model(mut self, model: &str) -> Self {
        self.small_model = model.to_string();
        self
    }

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

#[derive(Debug, Clone, Serialize)]
pub struct TextGenerationParams {
    pub prompt: String,
    pub system: Option<String>,
    pub model: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub frequency_penalty: Option<f32>,
    pub presence_penalty: Option<f32>,
    pub stop: Option<Vec<String>>,
}

impl TextGenerationParams {
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

    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    pub fn temperature(mut self, temp: f32) -> Self {
        self.temperature = Some(temp);
        self
    }

    pub fn max_tokens(mut self, max: u32) -> Self {
        self.max_tokens = Some(max);
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingParams {
    pub text: String,
    pub model: Option<String>,
    pub dimensions: Option<usize>,
}

impl EmbeddingParams {
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

#[derive(Debug, Clone)]
pub struct ImageDescriptionParams {
    pub image_url: String,
    pub model: Option<String>,
    pub prompt: Option<String>,
    pub max_tokens: Option<u32>,
}

impl ImageDescriptionParams {
    pub fn new(image_url: impl Into<String>) -> Self {
        Self {
            image_url: image_url.into(),
            model: None,
            prompt: None,
            max_tokens: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionChoice {
    pub index: u32,
    pub message: ChatMessage,
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionResponse {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub model: String,
    pub choices: Vec<ChatCompletionChoice>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingData {
    pub embedding: Vec<f32>,
    pub index: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingResponse {
    pub data: Vec<EmbeddingData>,
    pub model: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImageData {
    pub url: Option<String>,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImageGenerationResponse {
    pub created: u64,
    pub data: Vec<ImageData>,
}

#[derive(Debug, Clone)]
pub struct ImageGenerationResult {
    pub url: Option<String>,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ImageDescriptionResult {
    pub title: String,
    pub description: String,
}
