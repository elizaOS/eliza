//! Model types for elizaOS
//!
//! Contains model types, parameters, and results for AI model interactions.

use serde::{Deserialize, Serialize};

/// LLM Mode for overriding model selection.
///
/// - `Default`: Use the model type specified in the use_model call (no override)
/// - `Small`: Override all text generation model calls to use TEXT_SMALL
/// - `Large`: Override all text generation model calls to use TEXT_LARGE
///
/// This is useful for cost optimization (force Small) or quality (force Large).
/// While not recommended for production, it can be a fast way to make the agent run cheaper.
///
/// # Example
/// ```rust,no_run
/// use elizaos::runtime::{AgentRuntime, RuntimeOptions};
/// use elizaos::types::LLMMode;
///
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let rt = tokio::runtime::Runtime::new()?;
///     rt.block_on(async {
///         let _runtime = AgentRuntime::new(RuntimeOptions {
///             llm_mode: Some(LLMMode::Small), // All LLM calls will use TEXT_SMALL
///             ..Default::default()
///         })
///         .await?;
///         Ok::<(), Box<dyn std::error::Error>>(())
///     })?;
///     Ok(())
/// }
/// ```
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LLMMode {
    /// Use the model type as specified in the call (no override)
    #[default]
    Default,
    /// Override all text generation model calls to use TEXT_SMALL
    Small,
    /// Override all text generation model calls to use TEXT_LARGE
    Large,
}

impl std::str::FromStr for LLMMode {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s.to_uppercase().as_str() {
            "SMALL" => LLMMode::Small,
            "LARGE" => LLMMode::Large,
            _ => LLMMode::Default,
        })
    }
}

impl LLMMode {
    /// Parse LLM mode from a string (convenience method)
    pub fn parse(s: &str) -> Self {
        s.parse().unwrap_or(LLMMode::Default)
    }
}

/// Model type names
pub mod model_type {
    /// Small text model (kept for backwards compatibility)
    pub const SMALL: &str = "TEXT_SMALL";
    /// Medium text model (kept for backwards compatibility)
    pub const MEDIUM: &str = "TEXT_LARGE";
    /// Large text model (kept for backwards compatibility)
    pub const LARGE: &str = "TEXT_LARGE";
    /// Small text model
    pub const TEXT_SMALL: &str = "TEXT_SMALL";
    /// Large text model
    pub const TEXT_LARGE: &str = "TEXT_LARGE";
    /// Text embedding model
    pub const TEXT_EMBEDDING: &str = "TEXT_EMBEDDING";
    /// Text tokenizer encode
    pub const TEXT_TOKENIZER_ENCODE: &str = "TEXT_TOKENIZER_ENCODE";
    /// Text tokenizer decode
    pub const TEXT_TOKENIZER_DECODE: &str = "TEXT_TOKENIZER_DECODE";
    /// Small reasoning model
    pub const TEXT_REASONING_SMALL: &str = "REASONING_SMALL";
    /// Large reasoning model
    pub const TEXT_REASONING_LARGE: &str = "REASONING_LARGE";
    /// Text completion model
    pub const TEXT_COMPLETION: &str = "TEXT_COMPLETION";
    /// Image generation model
    pub const IMAGE: &str = "IMAGE";
    /// Image description model
    pub const IMAGE_DESCRIPTION: &str = "IMAGE_DESCRIPTION";
    /// Transcription model
    pub const TRANSCRIPTION: &str = "TRANSCRIPTION";
    /// Text to speech model
    pub const TEXT_TO_SPEECH: &str = "TEXT_TO_SPEECH";
    /// Audio processing model
    pub const AUDIO: &str = "AUDIO";
    /// Video processing model
    pub const VIDEO: &str = "VIDEO";
    /// Small object generation model
    pub const OBJECT_SMALL: &str = "OBJECT_SMALL";
    /// Large object generation model
    pub const OBJECT_LARGE: &str = "OBJECT_LARGE";
    /// Deep research model (o3-deep-research, o4-mini-deep-research)
    pub const RESEARCH: &str = "RESEARCH";
}

/// Model settings keys
pub mod model_settings {
    // Default settings
    /// Default maximum tokens setting key
    pub const DEFAULT_MAX_TOKENS: &str = "DEFAULT_MAX_TOKENS";
    /// Default temperature setting key
    pub const DEFAULT_TEMPERATURE: &str = "DEFAULT_TEMPERATURE";
    /// Default top-p setting key
    pub const DEFAULT_TOP_P: &str = "DEFAULT_TOP_P";
    /// Default top-k setting key
    pub const DEFAULT_TOP_K: &str = "DEFAULT_TOP_K";
    /// Default min-p setting key
    pub const DEFAULT_MIN_P: &str = "DEFAULT_MIN_P";
    /// Default seed setting key
    pub const DEFAULT_SEED: &str = "DEFAULT_SEED";
    /// Default repetition penalty setting key
    pub const DEFAULT_REPETITION_PENALTY: &str = "DEFAULT_REPETITION_PENALTY";
    /// Default frequency penalty setting key
    pub const DEFAULT_FREQUENCY_PENALTY: &str = "DEFAULT_FREQUENCY_PENALTY";
    /// Default presence penalty setting key
    pub const DEFAULT_PRESENCE_PENALTY: &str = "DEFAULT_PRESENCE_PENALTY";
}

/// Parameters for generating text
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateTextParams {
    /// The input prompt
    pub prompt: String,
    /// Maximum tokens to generate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    /// Minimum tokens to generate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_tokens: Option<i32>,
    /// Temperature for randomness (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Nucleus sampling parameter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    /// Top-k sampling
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<i32>,
    /// Minimum probability threshold
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_p: Option<f64>,
    /// Random seed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    /// Repetition penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repetition_penalty: Option<f64>,
    /// Frequency penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f64>,
    /// Presence penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f64>,
    /// Stop sequences
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    /// User identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Response format
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<ResponseFormat>,
    /// Enable streaming
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

/// Response format specification
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponseFormat {
    /// Structured format
    Structured {
        /// Format type
        #[serde(rename = "type")]
        format_type: ResponseFormatType,
    },
    /// String format
    String(String),
}

/// Response format type
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseFormatType {
    /// JSON object format
    JsonObject,
    /// Plain text format
    Text,
}

/// Token usage information
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageInfo {
    /// Prompt tokens
    pub prompt_tokens: i32,
    /// Completion tokens
    pub completion_tokens: i32,
    /// Total tokens
    pub total_tokens: i32,
}

/// Text stream chunk
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStreamChunk {
    /// Text content
    pub text: String,
    /// Whether this is the final chunk
    pub done: bool,
}

/// Generate text options (simplified API)
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateTextOptions {
    /// Include character personality
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_character: Option<bool>,
    /// Model type to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    /// Maximum tokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    /// Temperature
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Top-p (nucleus sampling)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f64>,
    /// Frequency penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f64>,
    /// Presence penalty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f64>,
    /// Stop sequences
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
}

/// Generate text result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateTextResult {
    /// Generated text
    pub text: String,
}

/// Text embedding parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEmbeddingParams {
    /// Text to embed
    pub text: String,
}

/// Tokenize text parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenizeTextParams {
    /// Text to tokenize
    pub prompt: String,
    /// Model type
    pub model_type: String,
}

/// Detokenize text parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetokenizeTextParams {
    /// Tokens to convert
    pub tokens: Vec<i32>,
    /// Model type
    pub model_type: String,
}

/// Image generation parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerationParams {
    /// Prompt describing the image
    pub prompt: String,
    /// Image dimensions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    /// Number of images
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i32>,
}

/// Image description parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDescriptionParams {
    /// Image URL
    pub image_url: String,
    /// Optional guiding prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// Image description result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDescriptionResult {
    /// Image title
    pub title: String,
    /// Image description
    pub description: String,
}

/// Transcription parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionParams {
    /// Audio URL
    pub audio_url: String,
    /// Optional guiding prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// Text to speech parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextToSpeechParams {
    /// Text to convert
    pub text: String,
    /// Voice to use
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    /// Speaking speed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
}

/// Object generation parameters
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectGenerationParams {
    /// Prompt describing the object
    pub prompt: String,
    /// JSON schema for validation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<serde_json::Value>,
    /// Output type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<ObjectOutputType>,
    /// Enum values (for enum output type)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    /// Model type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    /// Temperature
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    /// Maximum tokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i32>,
    /// Stop sequences
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
}

/// Object output type
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ObjectOutputType {
    /// Object output
    Object,
    /// Array output
    Array,
    /// Enum output
    Enum,
}

// ============================================================================
// Research Model Types (Deep Research)
// ============================================================================

/// Research tool configuration
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResearchTool {
    /// Web search tool
    WebSearchPreview,
    /// File search over vector stores
    FileSearch {
        /// Vector store IDs (max 2)
        vector_store_ids: Vec<String>,
    },
    /// Code interpreter for data analysis
    CodeInterpreter {
        /// Container configuration
        #[serde(skip_serializing_if = "Option::is_none")]
        container: Option<serde_json::Value>,
    },
    /// Remote MCP server
    Mcp {
        /// MCP server label
        server_label: String,
        /// MCP server URL
        server_url: String,
        /// Approval mode (must be "never" for deep research)
        #[serde(skip_serializing_if = "Option::is_none")]
        require_approval: Option<String>,
    },
}

/// Parameters for deep research models (o3-deep-research, o4-mini-deep-research)
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchParams {
    /// The research input/question
    pub input: String,
    /// Optional instructions to guide research
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Run in background mode for long tasks
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    /// Research tools (web_search_preview, file_search, mcp, code_interpreter)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ResearchTool>>,
    /// Maximum number of tool calls
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<i32>,
    /// Include reasoning summary ("auto" or "none")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_summary: Option<String>,
    /// Model variant (o3-deep-research or o4-mini-deep-research)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Annotation linking text to a source
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAnnotation {
    /// Source URL
    pub url: String,
    /// Source title
    pub title: String,
    /// Start index in text
    pub start_index: i32,
    /// End index in text
    pub end_index: i32,
}

/// Result from a deep research request
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchResult {
    /// Response ID
    pub id: String,
    /// Research report text with inline citations
    pub text: String,
    /// Source annotations
    #[serde(default)]
    pub annotations: Vec<ResearchAnnotation>,
    /// Research process output items
    #[serde(default)]
    pub output_items: Vec<serde_json::Value>,
    /// Background request status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// Model handler registration
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelHandlerInfo {
    /// Provider name
    pub provider: String,
    /// Priority (higher = preferred)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    /// Registration order
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_order: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_text_params_serialization() {
        let params = GenerateTextParams {
            prompt: "Hello, world!".to_string(),
            temperature: Some(0.7),
            max_tokens: Some(100),
            ..Default::default()
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"prompt\":\"Hello, world!\""));
        assert!(json.contains("\"temperature\":0.7"));
        assert!(json.contains("\"maxTokens\":100"));
    }

    #[test]
    fn test_response_format_serialization() {
        let format = ResponseFormat::Structured {
            format_type: ResponseFormatType::JsonObject,
        };
        let json = serde_json::to_string(&format).unwrap();
        assert!(json.contains("\"type\":\"json_object\""));
    }
}
