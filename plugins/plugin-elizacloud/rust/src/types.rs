#![allow(missing_docs)]
//! Type definitions for ElizaOS Cloud Plugin.

use serde::{Deserialize, Serialize};

/// Configuration for ElizaOS Cloud API client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElizaCloudConfig {
    /// API key for authentication
    pub api_key: String,
    /// Base URL for API requests
    pub base_url: String,
    /// Small/fast model identifier
    pub small_model: String,
    /// Large/powerful model identifier
    pub large_model: String,
    /// Embedding model identifier
    pub embedding_model: String,
    /// Embedding vector dimensions
    pub embedding_dimensions: usize,
    /// Optional separate API key for embeddings
    pub embedding_api_key: Option<String>,
    /// Optional separate URL for embeddings
    pub embedding_url: Option<String>,
    /// Image description model
    pub image_description_model: String,
    /// Max tokens for image description
    pub image_description_max_tokens: u32,
    /// Image generation model
    pub image_generation_model: String,
    /// Text-to-speech model
    pub tts_model: String,
    /// Text-to-speech voice
    pub tts_voice: String,
    /// Optional TTS instructions
    pub tts_instructions: Option<String>,
    /// Transcription model
    pub transcription_model: String,
    /// Enable experimental telemetry
    pub experimental_telemetry: bool,
}

impl ElizaCloudConfig {
    /// Create a new configuration with the given API key and defaults.
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: "https://www.elizacloud.ai/api/v1".to_string(),
            small_model: "gpt-4o-mini".to_string(),
            large_model: "gpt-4o".to_string(),
            embedding_model: "text-embedding-3-small".to_string(),
            embedding_dimensions: 1536,
            embedding_api_key: None,
            embedding_url: None,
            image_description_model: "gpt-4o-mini".to_string(),
            image_description_max_tokens: 8192,
            image_generation_model: "dall-e-3".to_string(),
            tts_model: "gpt-4o-mini-tts".to_string(),
            tts_voice: "nova".to_string(),
            tts_instructions: None,
            transcription_model: "gpt-4o-mini-transcribe".to_string(),
            experimental_telemetry: false,
        }
    }

    /// Set the base URL.
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    /// Set the small model.
    pub fn with_small_model(mut self, model: impl Into<String>) -> Self {
        self.small_model = model.into();
        self
    }

    /// Set the large model.
    pub fn with_large_model(mut self, model: impl Into<String>) -> Self {
        self.large_model = model.into();
        self
    }

    /// Set the embedding model.
    pub fn with_embedding_model(mut self, model: impl Into<String>) -> Self {
        self.embedding_model = model.into();
        self
    }

    /// Set the image generation model.
    pub fn with_image_generation_model(mut self, model: impl Into<String>) -> Self {
        self.image_generation_model = model.into();
        self
    }

    /// Set the transcription model.
    pub fn with_transcription_model(mut self, model: impl Into<String>) -> Self {
        self.transcription_model = model.into();
        self
    }
}

/// Parameters for text generation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TextGenerationParams {
    /// The prompt to generate from
    pub prompt: String,
    /// Temperature for generation (0.0 - 2.0)
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// Maximum tokens to generate
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// Frequency penalty (-2.0 - 2.0)
    #[serde(default = "default_penalty")]
    pub frequency_penalty: f32,
    /// Presence penalty (-2.0 - 2.0)
    #[serde(default = "default_penalty")]
    pub presence_penalty: f32,
    /// Stop sequences
    #[serde(default)]
    pub stop_sequences: Vec<String>,
    /// Whether to stream the response
    #[serde(default)]
    pub stream: bool,
}

fn default_temperature() -> f32 {
    0.7
}

fn default_max_tokens() -> u32 {
    8192
}

fn default_penalty() -> f32 {
    0.7
}

/// Parameters for structured object generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectGenerationParams {
    /// The prompt to generate from
    pub prompt: String,
    /// Optional JSON schema for validation
    pub schema: Option<serde_json::Value>,
    /// Temperature for generation (0.0 recommended for deterministic output)
    #[serde(default)]
    pub temperature: f32,
}


impl Default for ObjectGenerationParams {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            schema: None,
            temperature: 0.0,
        }
    }
}

/// Parameters for text embedding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextEmbeddingParams {
    /// Single text to embed (mutually exclusive with texts)
    pub text: Option<String>,
    /// Multiple texts to embed (mutually exclusive with text)
    pub texts: Option<Vec<String>>,
}

impl TextEmbeddingParams {
    /// Create params for a single text.
    pub fn single(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            texts: None,
        }
    }

    /// Create params for multiple texts.
    pub fn batch(texts: Vec<String>) -> Self {
        Self {
            text: None,
            texts: Some(texts),
        }
    }
}

/// Parameters for image generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenerationParams {
    /// The prompt to generate from
    pub prompt: String,
    /// Number of images to generate
    #[serde(default = "default_count")]
    pub count: u32,
    /// Image size (e.g., "1024x1024", "1792x1024", "1024x1792")
    #[serde(default = "default_size")]
    pub size: String,
    /// Image quality ("standard" or "hd")
    #[serde(default = "default_quality")]
    pub quality: String,
    /// Image style ("vivid" or "natural")
    #[serde(default = "default_style")]
    pub style: String,
}

fn default_count() -> u32 {
    1
}

fn default_size() -> String {
    "1024x1024".to_string()
}

fn default_quality() -> String {
    "standard".to_string()
}

fn default_style() -> String {
    "vivid".to_string()
}


impl Default for ImageGenerationParams {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            count: default_count(),
            size: default_size(),
            quality: default_quality(),
            style: default_style(),
        }
    }
}

/// Parameters for image description.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDescriptionParams {
    /// URL of the image to describe
    pub image_url: String,
    /// Optional custom prompt for description
    pub prompt: Option<String>,
}

impl ImageDescriptionParams {
    /// Create from just a URL.
    pub fn from_url(url: impl Into<String>) -> Self {
        Self {
            image_url: url.into(),
            prompt: None,
        }
    }

    /// Create with a custom prompt.
    pub fn with_prompt(url: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self {
            image_url: url.into(),
            prompt: Some(prompt.into()),
        }
    }
}

/// Result from image description.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDescriptionResult {
    /// Title for the image
    pub title: String,
    /// Detailed description of the image
    pub description: String,
}

/// Parameters for text-to-speech.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextToSpeechParams {
    /// Text to convert to speech
    pub text: String,
    /// Model to use (optional, uses config default)
    pub model: Option<String>,
    /// Voice to use (optional, uses config default)
    pub voice: Option<String>,
    /// Audio format ("mp3", "wav", "flac")
    #[serde(default = "default_format")]
    pub format: String,
    /// Optional instructions for the voice
    pub instructions: Option<String>,
}

fn default_format() -> String {
    "mp3".to_string()
}

/// Parameters for audio transcription.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionParams {
    /// Audio data as bytes
    #[serde(with = "serde_bytes")]
    pub audio: Vec<u8>,
    /// Model to use for transcription (optional, uses config default)
    pub model: Option<String>,
    /// Language hint (ISO 639-1)
    pub language: Option<String>,
    /// Response format
    #[serde(default = "default_response_format")]
    pub response_format: String,
    /// Optional prompt to guide transcription
    pub prompt: Option<String>,
    /// Temperature for transcription
    pub temperature: Option<f32>,
    /// MIME type of the audio
    #[serde(default = "default_mime_type")]
    pub mime_type: String,
    /// Timestamp granularities
    pub timestamp_granularities: Option<Vec<String>>,
}

fn default_response_format() -> String {
    "text".to_string()
}

fn default_mime_type() -> String {
    "audio/wav".to_string()
}


impl Default for TranscriptionParams {
    fn default() -> Self {
        Self {
            audio: Vec::new(),
            model: None,
            language: None,
            response_format: default_response_format(),
            prompt: None,
            temperature: None,
            mime_type: default_mime_type(),
            timestamp_granularities: None,
        }
    }
}

/// Parameters for text tokenization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenizeTextParams {
    /// Text to tokenize
    pub prompt: String,
    /// Model type ("TEXT_SMALL" or "TEXT_LARGE")
    #[serde(default = "default_model_type")]
    pub model_type: String,
}

fn default_model_type() -> String {
    "TEXT_LARGE".to_string()
}

/// Parameters for text detokenization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetokenizeTextParams {
    /// Token IDs to decode
    pub tokens: Vec<u32>,
    /// Model type ("TEXT_SMALL" or "TEXT_LARGE")
    #[serde(default = "default_model_type")]
    pub model_type: String,
}

/// Byte serialization helper
mod serde_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let s = STANDARD.encode(bytes);
        s.serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        STANDARD.decode(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_defaults() {
        let config = ElizaCloudConfig::new("test_key");
        assert_eq!(config.api_key, "test_key");
        assert_eq!(config.base_url, "https://www.elizacloud.ai/api/v1");
        assert_eq!(config.small_model, "gpt-4o-mini");
        assert_eq!(config.large_model, "gpt-4o");
        assert_eq!(config.transcription_model, "gpt-4o-mini-transcribe");
    }

    #[test]
    fn test_config_builder() {
        let config = ElizaCloudConfig::new("test_key")
            .with_base_url("https://custom.api.com")
            .with_small_model("custom-small")
            .with_large_model("custom-large")
            .with_transcription_model("whisper-1");

        assert_eq!(config.base_url, "https://custom.api.com");
        assert_eq!(config.small_model, "custom-small");
        assert_eq!(config.large_model, "custom-large");
        assert_eq!(config.transcription_model, "whisper-1");
    }

    #[test]
    fn test_text_generation_params_defaults() {
        let params = TextGenerationParams {
            prompt: "Test".to_string(),
            ..Default::default()
        };
        assert_eq!(params.temperature, 0.7);
        assert_eq!(params.max_tokens, 8192);
    }

    #[test]
    fn test_object_generation_params_defaults() {
        let params = ObjectGenerationParams {
            prompt: "Test".to_string(),
            ..Default::default()
        };
        assert_eq!(params.temperature, 0.0);
        assert!(params.schema.is_none());
    }

    #[test]
    fn test_embedding_params() {
        let single = TextEmbeddingParams::single("Hello");
        assert!(single.text.is_some());
        assert!(single.texts.is_none());

        let batch = TextEmbeddingParams::batch(vec!["Hello".to_string(), "World".to_string()]);
        assert!(batch.text.is_none());
        assert!(batch.texts.is_some());
    }

    #[test]
    fn test_image_description_params() {
        let url_only = ImageDescriptionParams::from_url("https://example.com/image.jpg");
        assert_eq!(url_only.image_url, "https://example.com/image.jpg");
        assert!(url_only.prompt.is_none());

        let with_prompt =
            ImageDescriptionParams::with_prompt("https://example.com/image.jpg", "Describe this");
        assert_eq!(with_prompt.prompt, Some("Describe this".to_string()));
    }

    #[test]
    fn test_transcription_params_defaults() {
        let params = TranscriptionParams::default();
        assert!(params.model.is_none());
        assert_eq!(params.response_format, "text");
        assert_eq!(params.mime_type, "audio/wav");
    }
}
