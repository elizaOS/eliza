#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TTSVoice {
    Alloy,
    Echo,
    Fable,
    Onyx,
    #[default]
    Nova,
    Shimmer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TTSOutputFormat {
    #[default]
    Mp3,
    Wav,
    Flac,
    Opus,
    Aac,
    Pcm,
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionResponseFormat {
    #[default]
    Json,
    Text,
    Srt,
    VerboseJson,
    Vtt,
}

#[derive(Debug, Clone)]
pub struct OpenAIConfig {
    pub api_key: String,
    pub base_url: String,
    pub embedding_model: String,
    pub embedding_dimensions: usize,
    pub large_model: String,
    pub small_model: String,
    pub image_model: String,
    pub transcription_model: String,
    pub tts_model: String,
    pub tts_voice: TTSVoice,
    pub timeout_secs: u64,
    pub research_model: String,
    pub research_timeout_secs: u64,
}

impl OpenAIConfig {
    pub fn new(api_key: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            embedding_model: "text-embedding-3-small".to_string(),
            embedding_dimensions: 1536,
            large_model: "gpt-5".to_string(),
            small_model: "gpt-5-mini".to_string(),
            image_model: "dall-e-3".to_string(),
            transcription_model: "whisper-1".to_string(),
            tts_model: "tts-1".to_string(),
            tts_voice: TTSVoice::default(),
            timeout_secs: 120,
            research_model: "o3-deep-research".to_string(),
            research_timeout_secs: 3600, // 1 hour for research
        }
    }

    /// Set the research model.
    pub fn research_model(mut self, model: &str) -> Self {
        self.research_model = model.to_string();
        self
    }

    /// Set the research timeout.
    pub fn research_timeout_secs(mut self, secs: u64) -> Self {
        self.research_timeout_secs = secs;
        self
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

#[derive(Debug, Clone, Serialize)]
pub struct ImageGenerationParams {
    pub prompt: String,
    pub model: Option<String>,
    pub n: Option<u32>,
    pub size: Option<ImageSize>,
    pub quality: Option<ImageQuality>,
    pub style: Option<ImageStyle>,
}

impl ImageGenerationParams {
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

#[derive(Debug, Clone, Serialize, Default)]
pub struct TranscriptionParams {
    pub model: Option<String>,
    pub language: Option<String>,
    pub prompt: Option<String>,
    pub temperature: Option<f32>,
    pub response_format: Option<TranscriptionResponseFormat>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextToSpeechParams {
    pub text: String,
    pub model: Option<String>,
    pub voice: Option<TTSVoice>,
    pub response_format: Option<TTSOutputFormat>,
    pub speed: Option<f32>,
}

impl TextToSpeechParams {
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

#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptionResponse {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub object: String,
    pub created: u64,
    pub owned_by: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelsResponse {
    pub object: String,
    pub data: Vec<ModelInfo>,
}

// ============================================================================
// Research Types (Deep Research)
// ============================================================================

/// Parameters for deep research requests
#[derive(Debug, Clone, Serialize)]
pub struct ResearchParams {
    /// Research input/question
    pub input: String,
    /// Optional instructions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Run in background mode
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    /// Research tools
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<serde_json::Value>>,
    /// Maximum tool calls
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<i32>,
    /// Reasoning summary mode ("auto" or "none")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    /// Model variant
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl ResearchParams {
    pub fn new(input: impl Into<String>) -> Self {
        Self {
            input: input.into(),
            instructions: None,
            background: None,
            tools: None,
            max_tool_calls: None,
            reasoning_summary: None,
            model: None,
        }
    }

    pub fn instructions(mut self, instructions: impl Into<String>) -> Self {
        self.instructions = Some(instructions.into());
        self
    }

    pub fn background(mut self, background: bool) -> Self {
        self.background = Some(background);
        self
    }

    pub fn tools(mut self, tools: Vec<serde_json::Value>) -> Self {
        self.tools = Some(tools);
        self
    }

    pub fn max_tool_calls(mut self, max: i32) -> Self {
        self.max_tool_calls = Some(max);
        self
    }

    pub fn reasoning_summary(mut self, summary: impl Into<String>) -> Self {
        self.reasoning_summary = Some(summary.into());
        self
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }
}

/// Annotation linking text to a source
#[derive(Debug, Clone, Deserialize)]
pub struct ResearchAnnotation {
    pub url: String,
    pub title: String,
    pub start_index: i32,
    pub end_index: i32,
}

/// Result from a deep research request
#[derive(Debug, Clone)]
pub struct ResearchResult {
    pub id: String,
    pub text: String,
    pub annotations: Vec<ResearchAnnotation>,
    pub output_items: Vec<serde_json::Value>,
    pub status: Option<String>,
}

/// Raw response from Responses API
#[derive(Debug, Clone, Deserialize)]
pub struct ResponsesApiResponse {
    pub id: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub output: Vec<serde_json::Value>,
    #[serde(default)]
    pub output_text: Option<String>,
    #[serde(default)]
    pub error: Option<ResponsesApiError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResponsesApiError {
    pub message: String,
    #[serde(default)]
    pub code: Option<String>,
}
