//! Core types for the Anthropic API.
//!
//! All types are strongly typed with explicit field requirements.
//! No Option types for required fields.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Message role in a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// User message.
    User,
    /// Assistant (Claude) message.
    Assistant,
}

impl Role {
    /// Get the string representation of the role.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// Content block types in a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Text content.
    Text {
        /// The text content.
        text: String,
    },
    /// Image content (base64 encoded).
    Image {
        /// Image source information.
        source: ImageSource,
    },
    /// Tool use request from Claude.
    ToolUse {
        /// Tool use ID.
        id: String,
        /// Tool name.
        name: String,
        /// Tool input as JSON.
        input: serde_json::Value,
    },
    /// Tool result from user.
    ToolResult {
        /// Tool use ID this result corresponds to.
        tool_use_id: String,
        /// Result content.
        content: String,
    },
    /// Thinking block (for chain-of-thought).
    Thinking {
        /// The thinking text.
        thinking: String,
    },
}

impl ContentBlock {
    /// Create a text content block.
    pub fn text<S: Into<String>>(text: S) -> Self {
        Self::Text { text: text.into() }
    }

    /// Get the text content if this is a text block.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            _ => None,
        }
    }
}

/// Image source for image content blocks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSource {
    /// Source type (currently only "base64").
    #[serde(rename = "type")]
    pub source_type: String,
    /// Media type (e.g., "image/jpeg").
    pub media_type: String,
    /// Base64 encoded image data.
    pub data: String,
}

/// A message in a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// Role of the message sender.
    pub role: Role,
    /// Content blocks in the message.
    pub content: Vec<ContentBlock>,
}

impl Message {
    /// Create a user message with text content.
    pub fn user<S: Into<String>>(text: S) -> Self {
        Self {
            role: Role::User,
            content: vec![ContentBlock::text(text)],
        }
    }

    /// Create an assistant message with text content.
    pub fn assistant<S: Into<String>>(text: S) -> Self {
        Self {
            role: Role::Assistant,
            content: vec![ContentBlock::text(text)],
        }
    }

    /// Get all text content from this message.
    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(|block| block.as_text())
            .collect::<Vec<_>>()
            .join("")
    }
}

/// Token usage information from API response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Number of tokens in the input.
    pub input_tokens: u32,
    /// Number of tokens in the output.
    pub output_tokens: u32,
    /// Cache creation tokens (if caching is used).
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
    /// Cache read tokens (if caching is used).
    #[serde(default)]
    pub cache_read_input_tokens: u32,
}

impl TokenUsage {
    /// Get total tokens used.
    pub fn total_tokens(&self) -> u32 {
        self.input_tokens + self.output_tokens
    }
}

/// Parameters for text generation.
#[derive(Debug, Clone, Default)]
pub struct TextGenerationParams {
    /// The prompt to generate from.
    pub prompt: String,
    /// Optional system prompt.
    pub system: Option<String>,
    /// Message history for multi-turn conversations.
    pub messages: Option<Vec<Message>>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// Temperature (0.0 to 1.0). Cannot be used with top_p.
    pub temperature: Option<f32>,
    /// Top-p sampling (0.0 to 1.0). Cannot be used with temperature.
    pub top_p: Option<f32>,
    /// Stop sequences.
    pub stop_sequences: Option<Vec<String>>,
    /// Chain-of-thought budget in tokens.
    pub thinking_budget: Option<u32>,
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
        self.top_p = None; // Clear top_p since they're mutually exclusive
        self
    }

    /// Set top_p.
    pub fn with_top_p(mut self, top_p: f32) -> Self {
        self.top_p = Some(top_p);
        self.temperature = None; // Clear temperature since they're mutually exclusive
        self
    }

    /// Set thinking budget for chain-of-thought.
    pub fn with_thinking_budget(mut self, budget: u32) -> Self {
        self.thinking_budget = Some(budget);
        self
    }
}

/// Response from text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationResponse {
    /// The generated text.
    pub text: String,
    /// The thinking text (if chain-of-thought was enabled).
    pub thinking: Option<String>,
    /// Token usage information.
    pub usage: TokenUsage,
    /// Stop reason.
    pub stop_reason: StopReason,
    /// Model used for generation.
    pub model: String,
}

/// Reason generation stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// Reached natural end of generation.
    #[default]
    EndTurn,
    /// Hit a stop sequence.
    StopSequence,
    /// Reached max tokens.
    MaxTokens,
    /// Model wants to use a tool.
    ToolUse,
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

#[allow(clippy::derivable_impls)]
impl Default for ObjectGenerationParams {
    fn default() -> Self {
        Self {
            prompt: String::new(),
            system: None,
            schema: None,
            temperature: Some(0.2), // Lower default for structured output
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

/// Request body for the Anthropic messages API.
#[derive(Debug, Serialize)]
pub(crate) struct MessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
}

/// Response body from the Anthropic messages API.
#[derive(Debug, Deserialize)]
pub(crate) struct MessagesResponse {
    pub content: Vec<ContentBlock>,
    pub model: String,
    pub stop_reason: Option<StopReason>,
    pub usage: TokenUsage,
}

/// Error response from the Anthropic API.
#[derive(Debug, Deserialize)]
pub(crate) struct ErrorResponse {
    pub error: ErrorDetail,
}

/// Error detail from the Anthropic API.
#[derive(Debug, Deserialize)]
pub(crate) struct ErrorDetail {
    #[serde(rename = "type")]
    pub error_type: String,
    pub message: String,
}


