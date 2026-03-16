use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The role of a message participant in a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// A message from the user.
    User,
    /// A message from the assistant.
    Assistant,
}

impl Role {
    /// Returns the role as a string slice.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// A content block within a message.
///
/// Messages can contain multiple content blocks of different types,
/// such as text, images, tool use, and thinking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// A text content block.
    Text {
        /// The text content.
        text: String,
    },
    /// An image content block.
    Image {
        /// The image source data.
        source: ImageSource,
    },
    /// A tool use request from the model.
    ToolUse {
        /// Unique identifier for this tool use.
        id: String,
        /// The name of the tool to use.
        name: String,
        /// The input parameters for the tool.
        input: serde_json::Value,
    },
    /// The result of a tool invocation.
    ToolResult {
        /// The ID of the tool use this is a result for.
        tool_use_id: String,
        /// The content returned by the tool.
        content: String,
    },
    /// Model's thinking/reasoning content (for extended thinking mode).
    Thinking {
        /// The model's thinking process.
        thinking: String,
    },
}

impl ContentBlock {
    /// Creates a new text content block.
    pub fn text<S: Into<String>>(text: S) -> Self {
        Self::Text { text: text.into() }
    }

    /// Returns the text content if this is a text block, otherwise None.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            _ => None,
        }
    }
}

/// Source data for an image content block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSource {
    /// The type of image source (e.g., "base64").
    #[serde(rename = "type")]
    pub source_type: String,
    /// The MIME type of the image (e.g., "image/png").
    pub media_type: String,
    /// The image data (base64-encoded for base64 source type).
    pub data: String,
}

/// A message in a conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// The role of the message sender.
    pub role: Role,
    /// The content blocks that make up the message.
    pub content: Vec<ContentBlock>,
}

impl Message {
    /// Creates a new user message with text content.
    pub fn user<S: Into<String>>(text: S) -> Self {
        Self {
            role: Role::User,
            content: vec![ContentBlock::text(text)],
        }
    }

    /// Creates a new assistant message with text content.
    pub fn assistant<S: Into<String>>(text: S) -> Self {
        Self {
            role: Role::Assistant,
            content: vec![ContentBlock::text(text)],
        }
    }

    /// Extracts and concatenates all text content from this message.
    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(|block| block.as_text())
            .collect::<Vec<_>>()
            .join("")
    }
}

/// Token usage statistics for an API request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    /// Number of tokens in the input/prompt.
    pub input_tokens: u32,
    /// Number of tokens in the output/response.
    pub output_tokens: u32,
    /// Tokens used to create cache entries.
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
    /// Tokens read from cache.
    #[serde(default)]
    pub cache_read_input_tokens: u32,
}

impl TokenUsage {
    /// Returns the total number of tokens (input + output).
    pub fn total_tokens(&self) -> u32 {
        self.input_tokens + self.output_tokens
    }
}

/// Parameters for text generation requests.
#[derive(Debug, Clone, Default)]
pub struct TextGenerationParams {
    /// The prompt to send to the model.
    pub prompt: String,
    /// Optional system prompt to set context.
    pub system: Option<String>,
    /// Optional conversation history.
    pub messages: Option<Vec<Message>>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// Sampling temperature (0.0-1.0). Cannot be used with top_p.
    pub temperature: Option<f32>,
    /// Nucleus sampling parameter. Cannot be used with temperature.
    pub top_p: Option<f32>,
    /// Sequences that will stop generation.
    pub stop_sequences: Option<Vec<String>>,
    /// Budget for extended thinking mode.
    pub thinking_budget: Option<u32>,
}

impl TextGenerationParams {
    /// Creates new text generation parameters with the given prompt.
    pub fn new<S: Into<String>>(prompt: S) -> Self {
        Self {
            prompt: prompt.into(),
            ..Default::default()
        }
    }

    /// Sets the system prompt.
    pub fn with_system<S: Into<String>>(mut self, system: S) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Sets the maximum tokens to generate.
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    /// Sets the sampling temperature. Clears top_p if set.
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self.top_p = None;
        self
    }

    /// Sets the nucleus sampling parameter. Clears temperature if set.
    pub fn with_top_p(mut self, top_p: f32) -> Self {
        self.top_p = Some(top_p);
        self.temperature = None;
        self
    }

    /// Sets the budget for extended thinking mode.
    pub fn with_thinking_budget(mut self, budget: u32) -> Self {
        self.thinking_budget = Some(budget);
        self
    }
}

/// Response from a text generation request.
#[derive(Debug, Clone)]
pub struct TextGenerationResponse {
    /// The generated text.
    pub text: String,
    /// The model's thinking process, if extended thinking was enabled.
    pub thinking: Option<String>,
    /// Token usage statistics.
    pub usage: TokenUsage,
    /// The reason generation stopped.
    pub stop_reason: StopReason,
    /// The model that generated this response.
    pub model: String,
}

/// Reasons why text generation stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The model naturally finished its response.
    #[default]
    EndTurn,
    /// A stop sequence was encountered.
    StopSequence,
    /// Maximum tokens were reached.
    MaxTokens,
    /// The model wants to use a tool.
    ToolUse,
}

/// Parameters for JSON object generation requests.
#[derive(Debug, Clone)]
pub struct ObjectGenerationParams {
    /// The prompt describing the object to generate.
    pub prompt: String,
    /// Optional system prompt to set context.
    pub system: Option<String>,
    /// Optional JSON schema for the expected output.
    pub schema: Option<serde_json::Value>,
    /// Sampling temperature (lower values are more deterministic).
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
            temperature: Some(0.2),
            max_tokens: None,
        }
    }
}

impl ObjectGenerationParams {
    /// Creates new object generation parameters with the given prompt.
    pub fn new<S: Into<String>>(prompt: S) -> Self {
        Self {
            prompt: prompt.into(),
            ..Default::default()
        }
    }

    /// Sets the system prompt.
    pub fn with_system<S: Into<String>>(mut self, system: S) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Sets the JSON schema for validation.
    pub fn with_schema(mut self, schema: serde_json::Value) -> Self {
        self.schema = Some(schema);
        self
    }

    /// Sets the sampling temperature.
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }
}

/// Response from a JSON object generation request.
#[derive(Debug, Clone)]
pub struct ObjectGenerationResponse {
    /// The generated JSON object.
    pub object: serde_json::Value,
    /// Token usage statistics.
    pub usage: TokenUsage,
    /// The model that generated this response.
    pub model: String,
}

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

#[derive(Debug, Deserialize)]
pub(crate) struct MessagesResponse {
    pub content: Vec<ContentBlock>,
    pub model: String,
    pub stop_reason: Option<StopReason>,
    pub usage: TokenUsage,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ErrorResponse {
    pub error: ErrorDetail,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ErrorDetail {
    #[serde(rename = "type")]
    pub error_type: String,
    pub message: String,
}
