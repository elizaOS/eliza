//! OpenAI Plugin Types
//!
//! Strong types with Serde validation for all API interactions.

use serde::{Deserialize, Serialize};

// ============================================================================
// Enums
// ============================================================================

/// Supported TTS voices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TTSVoice {
    /// Alloy voice
    Alloy,
    /// Echo voice
    Echo,
    /// Fable voice
    Fable,
    /// Onyx voice
    Onyx,
    /// Nova voice (default)
    Nova,
    /// Shimmer voice
    Shimmer,
}

impl Default for TTSVoice {
    fn default() -> Self {
        Self::Nova
    }
}

/// Supported TTS output formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TTSOutputFormat {
    /// MP3 format (default)
    Mp3,
    /// WAV format
    Wav,
    /// FLAC format
    Flac,
    /// Opus format
    Opus,
    /// AAC format
    Aac,
    /// PCM format
    Pcm,
}

impl Default for TTSOutputFormat {
    fn default() -> Self {
        Self::Mp3
    }
}

/// Image sizes for DALL-E.
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

/// Transcription response format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionResponseFormat {
    /// JSON format (default)
    Json,
    /// Plain text format
    Text,
    /// SRT subtitle format
    Srt,
    /// Verbose JSON with timestamps
    VerboseJson,
    /// WebVTT subtitle format
    Vtt,
}

impl Default for TranscriptionResponseFormat {
    fn default() -> Self {
        Self::Json
    }
}

// ============================================================================
// Configuration
// ============================================================================

/// OpenAI client configuration.
#[derive(Debug, Clone)]
pub struct OpenAIConfig {
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
    /// Model for transcription.
    pub transcription_model: String,
    /// Model for TTS.
    pub tts_model: String,
    /// Default TTS voice.
    pub tts_voice: TTSVoice,
    /// Request timeout in seconds.
    pub timeout_secs: u64,
}

impl OpenAIConfig {
    /// Create a new configuration with required API key.
    pub fn new(api_key: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            embedding_model: "text-embedding-3-small".to_string(),
            embedding_dimensions: 1536,
            large_model: "gpt-4o".to_string(),
            small_model: "gpt-4o-mini".to_string(),
            image_model: "dall-e-3".to_string(),
            transcription_model: "whisper-1".to_string(),
            tts_model: "tts-1".to_string(),
            tts_voice: TTSVoice::default(),
            timeout_secs: 120,
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

/// Parameters for audio transcription.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptionParams {
    /// Model to use.
    pub model: Option<String>,
    /// Language hint.
    pub language: Option<String>,
    /// Prompt hint.
    pub prompt: Option<String>,
    /// Temperature for sampling.
    pub temperature: Option<f32>,
    /// Response format.
    pub response_format: Option<TranscriptionResponseFormat>,
}

impl Default for TranscriptionParams {
    fn default() -> Self {
        Self {
            model: None,
            language: None,
            prompt: None,
            temperature: None,
            response_format: None,
        }
    }
}

/// Parameters for text-to-speech.
#[derive(Debug, Clone, Serialize)]
pub struct TextToSpeechParams {
    /// Text to convert.
    pub text: String,
    /// Model to use.
    pub model: Option<String>,
    /// Voice to use.
    pub voice: Option<TTSVoice>,
    /// Output format.
    pub response_format: Option<TTSOutputFormat>,
    /// Speech speed (0.25-4.0).
    pub speed: Option<f32>,
}

impl TextToSpeechParams {
    /// Create new TTS parameters.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            model: None,
            voice: None,
            response_format: None,
            speed: None,
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

/// Transcription response.
#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptionResponse {
    /// Transcribed text.
    pub text: String,
}

/// Model information.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelInfo {
    /// Model ID.
    pub id: String,
    /// Object type.
    pub object: String,
    /// Creation timestamp.
    pub created: u64,
    /// Owner organization.
    pub owned_by: String,
}

/// Models list response.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelsResponse {
    /// Object type.
    pub object: String,
    /// List of models.
    pub data: Vec<ModelInfo>,
}
