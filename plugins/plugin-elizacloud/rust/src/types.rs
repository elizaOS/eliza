#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElizaCloudConfig {
    pub api_key: String,
    pub base_url: String,
    pub small_model: String,
    pub large_model: String,
    pub embedding_model: String,
    pub embedding_dimensions: usize,
    pub embedding_api_key: Option<String>,
    pub embedding_url: Option<String>,
    pub image_description_model: String,
    pub image_description_max_tokens: u32,
    pub image_generation_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub tts_instructions: Option<String>,
    pub transcription_model: String,
    pub experimental_telemetry: bool,
}

impl ElizaCloudConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: "https://www.elizacloud.ai/api/v1".to_string(),
            small_model: "gpt-5-mini".to_string(),
            large_model: "gpt-5".to_string(),
            embedding_model: "text-embedding-3-small".to_string(),
            embedding_dimensions: 1536,
            embedding_api_key: None,
            embedding_url: None,
            image_description_model: "gpt-5-mini".to_string(),
            image_description_max_tokens: 8192,
            image_generation_model: "dall-e-3".to_string(),
            tts_model: "gpt-5-mini-tts".to_string(),
            tts_voice: "nova".to_string(),
            tts_instructions: None,
            transcription_model: "gpt-5-mini-transcribe".to_string(),
            experimental_telemetry: false,
        }
    }

    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into();
        self
    }

    pub fn with_small_model(mut self, model: impl Into<String>) -> Self {
        self.small_model = model.into();
        self
    }

    pub fn with_large_model(mut self, model: impl Into<String>) -> Self {
        self.large_model = model.into();
        self
    }

    pub fn with_embedding_model(mut self, model: impl Into<String>) -> Self {
        self.embedding_model = model.into();
        self
    }

    pub fn with_image_generation_model(mut self, model: impl Into<String>) -> Self {
        self.image_generation_model = model.into();
        self
    }

    pub fn with_transcription_model(mut self, model: impl Into<String>) -> Self {
        self.transcription_model = model.into();
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextGenerationParams {
    pub prompt: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_penalty")]
    pub frequency_penalty: f32,
    #[serde(default = "default_penalty")]
    pub presence_penalty: f32,
    #[serde(default)]
    pub stop_sequences: Vec<String>,
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

impl Default for TextGenerationParams {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            frequency_penalty: default_penalty(),
            presence_penalty: default_penalty(),
            stop_sequences: Vec::new(),
            stream: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectGenerationParams {
    pub prompt: String,
    pub schema: Option<serde_json::Value>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextEmbeddingParams {
    pub text: Option<String>,
    pub texts: Option<Vec<String>>,
}

impl TextEmbeddingParams {
    pub fn single(text: impl Into<String>) -> Self {
        Self {
            text: Some(text.into()),
            texts: None,
        }
    }

    pub fn batch(texts: Vec<String>) -> Self {
        Self {
            text: None,
            texts: Some(texts),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenerationParams {
    pub prompt: String,
    #[serde(default = "default_count")]
    pub count: u32,
    #[serde(default = "default_size")]
    pub size: String,
    #[serde(default = "default_quality")]
    pub quality: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDescriptionParams {
    pub image_url: String,
    pub prompt: Option<String>,
}

impl ImageDescriptionParams {
    pub fn from_url(url: impl Into<String>) -> Self {
        Self {
            image_url: url.into(),
            prompt: None,
        }
    }

    pub fn with_prompt(url: impl Into<String>, prompt: impl Into<String>) -> Self {
        Self {
            image_url: url.into(),
            prompt: Some(prompt.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageDescriptionResult {
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextToSpeechParams {
    pub text: String,
    pub model: Option<String>,
    pub voice: Option<String>,
    #[serde(default = "default_format")]
    pub format: String,
    pub instructions: Option<String>,
}

fn default_format() -> String {
    "mp3".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionParams {
    #[serde(with = "serde_bytes")]
    pub audio: Vec<u8>,
    pub model: Option<String>,
    pub language: Option<String>,
    #[serde(default = "default_response_format")]
    pub response_format: String,
    pub prompt: Option<String>,
    pub temperature: Option<f32>,
    #[serde(default = "default_mime_type")]
    pub mime_type: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetokenizeTextParams {
    pub tokens: Vec<u32>,
    #[serde(default = "default_model_type")]
    pub model_type: String,
}

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
        assert_eq!(config.small_model, "gpt-5-mini");
        assert_eq!(config.large_model, "gpt-5");
        assert_eq!(config.transcription_model, "gpt-5-mini-transcribe");
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
