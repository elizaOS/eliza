//! Type definitions for the Groq plugin.

use serde::{Deserialize, Serialize};

/// Parameters for text generation
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GenerateTextParams {
    /// The prompt to generate from
    pub prompt: String,
    /// System message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Temperature (0.0 to 2.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Maximum tokens to generate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Frequency penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f64>,
    /// Presence penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f64>,
    /// Stop sequences
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop: Vec<String>,
}

/// Parameters for object generation
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GenerateObjectParams {
    /// The prompt
    pub prompt: String,
    /// Temperature
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

/// Parameters for transcription
#[derive(Debug, Clone)]
pub struct TranscriptionParams {
    /// Audio data
    pub audio: Vec<u8>,
    /// Audio format (mp3, wav, etc)
    pub format: String,
}

/// Parameters for text-to-speech
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextToSpeechParams {
    /// Text to synthesize
    pub text: String,
    /// Voice to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

/// Message role
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    /// System message
    System,
    /// User message
    User,
    /// Assistant message
    Assistant,
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Role
    pub role: MessageRole,
    /// Content
    pub content: String,
}

/// Chat completion request
#[derive(Debug, Clone, Serialize)]
pub struct ChatCompletionRequest {
    /// Model
    pub model: String,
    /// Messages
    pub messages: Vec<ChatMessage>,
    /// Temperature
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Max tokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Frequency penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f64>,
    /// Presence penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f64>,
    /// Stop sequences
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
}

/// Chat choice
#[derive(Debug, Clone, Deserialize)]
pub struct ChatChoice {
    /// Index
    pub index: u32,
    /// Message
    pub message: ChatMessage,
    /// Finish reason
    pub finish_reason: Option<String>,
}

/// Chat completion response
#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionResponse {
    /// ID
    pub id: String,
    /// Model
    pub model: String,
    /// Choices
    pub choices: Vec<ChatChoice>,
}

/// Transcription response
#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptionResponse {
    /// Transcribed text
    pub text: String,
}

/// Model info
#[derive(Debug, Clone, Deserialize)]
pub struct ModelInfo {
    /// Model ID
    pub id: String,
    /// Owner
    pub owned_by: String,
}

/// Models list response
#[derive(Debug, Clone, Deserialize)]
pub struct ModelsResponse {
    /// Models
    pub data: Vec<ModelInfo>,
}

/// Client configuration
#[derive(Debug, Clone)]
pub struct GroqConfig {
    /// API key
    pub api_key: String,
    /// Base URL
    pub base_url: String,
    /// Small model
    pub small_model: String,
    /// Large model
    pub large_model: String,
    /// TTS model
    pub tts_model: String,
    /// TTS voice
    pub tts_voice: String,
    /// Transcription model
    pub transcription_model: String,
}

impl Default for GroqConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: crate::DEFAULT_BASE_URL.to_string(),
            small_model: crate::DEFAULT_SMALL_MODEL.to_string(),
            large_model: crate::DEFAULT_LARGE_MODEL.to_string(),
            tts_model: crate::DEFAULT_TTS_MODEL.to_string(),
            tts_voice: crate::DEFAULT_TTS_VOICE.to_string(),
            transcription_model: crate::DEFAULT_TRANSCRIPTION_MODEL.to_string(),
        }
    }
}
