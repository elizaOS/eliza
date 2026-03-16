//! Type definitions for the Copilot Proxy plugin.

use serde::{Deserialize, Serialize};

/// OpenAI-compatible chat message role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    /// System message.
    System,
    /// User message.
    User,
    /// Assistant message.
    Assistant,
}

/// OpenAI-compatible chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// The role of the message author.
    pub role: ChatRole,
    /// The content of the message.
    pub content: Option<String>,
}

impl ChatMessage {
    /// Create a new system message.
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::System,
            content: Some(content.into()),
        }
    }

    /// Create a new user message.
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: Some(content.into()),
        }
    }

    /// Create a new assistant message.
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: Some(content.into()),
        }
    }
}

/// OpenAI-compatible chat completion request.
#[derive(Debug, Clone, Serialize)]
pub struct ChatCompletionRequest {
    /// The model to use.
    pub model: String,
    /// The messages to generate a completion for.
    pub messages: Vec<ChatMessage>,
    /// Maximum tokens to generate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Sampling temperature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// Top-p sampling.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_p: Option<f32>,
    /// Frequency penalty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_penalty: Option<f32>,
    /// Presence penalty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence_penalty: Option<f32>,
    /// Stop sequences.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
    /// Whether to stream the response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
}

impl ChatCompletionRequest {
    /// Create a new chat completion request.
    pub fn new(model: impl Into<String>, messages: Vec<ChatMessage>) -> Self {
        Self {
            model: model.into(),
            messages,
            max_tokens: None,
            temperature: None,
            top_p: None,
            frequency_penalty: None,
            presence_penalty: None,
            stop: None,
            stream: None,
        }
    }

    /// Set the maximum tokens.
    pub fn max_tokens(mut self, tokens: u32) -> Self {
        self.max_tokens = Some(tokens);
        self
    }

    /// Set the temperature.
    pub fn temperature(mut self, temp: f32) -> Self {
        self.temperature = Some(temp);
        self
    }

    /// Set top-p sampling.
    pub fn top_p(mut self, p: f32) -> Self {
        self.top_p = Some(p);
        self
    }

    /// Set frequency penalty.
    pub fn frequency_penalty(mut self, penalty: f32) -> Self {
        self.frequency_penalty = Some(penalty);
        self
    }

    /// Set presence penalty.
    pub fn presence_penalty(mut self, penalty: f32) -> Self {
        self.presence_penalty = Some(penalty);
        self
    }

    /// Set stop sequences.
    pub fn stop(mut self, sequences: Vec<String>) -> Self {
        self.stop = Some(sequences);
        self
    }
}

/// OpenAI-compatible chat completion choice.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionChoice {
    /// The index of this choice.
    pub index: u32,
    /// The generated message.
    pub message: ChatMessage,
    /// The reason the generation stopped.
    pub finish_reason: Option<String>,
}

/// Token usage statistics.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenUsage {
    /// Tokens used in the prompt.
    pub prompt_tokens: u32,
    /// Tokens used in the completion.
    pub completion_tokens: u32,
    /// Total tokens used.
    pub total_tokens: u32,
}

/// OpenAI-compatible chat completion response.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatCompletionResponse {
    /// Unique identifier for this completion.
    pub id: String,
    /// The object type (always "chat.completion").
    pub object: String,
    /// Unix timestamp of creation.
    pub created: u64,
    /// The model used.
    pub model: String,
    /// The generated choices.
    pub choices: Vec<ChatCompletionChoice>,
    /// Token usage statistics.
    pub usage: Option<TokenUsage>,
}

/// Parameters for text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationParams {
    /// The prompt to generate text for.
    pub prompt: String,
    /// Optional system message.
    pub system: Option<String>,
    /// Optional model override.
    pub model: Option<String>,
    /// Sampling temperature.
    pub temperature: Option<f32>,
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// Frequency penalty.
    pub frequency_penalty: Option<f32>,
    /// Presence penalty.
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

    /// Set the system message.
    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Set the model.
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Set the temperature.
    pub fn temperature(mut self, temp: f32) -> Self {
        self.temperature = Some(temp);
        self
    }

    /// Set the maximum tokens.
    pub fn max_tokens(mut self, tokens: u32) -> Self {
        self.max_tokens = Some(tokens);
        self
    }

    /// Set the frequency penalty.
    pub fn frequency_penalty(mut self, penalty: f32) -> Self {
        self.frequency_penalty = Some(penalty);
        self
    }

    /// Set the presence penalty.
    pub fn presence_penalty(mut self, penalty: f32) -> Self {
        self.presence_penalty = Some(penalty);
        self
    }

    /// Set stop sequences.
    pub fn stop(mut self, sequences: Vec<String>) -> Self {
        self.stop = Some(sequences);
        self
    }
}

/// Result of text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationResult {
    /// The generated text.
    pub text: String,
    /// Token usage statistics.
    pub usage: Option<TokenUsage>,
}

/// Model information from the API.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelInfo {
    /// The model ID.
    pub id: String,
    /// The object type.
    pub object: String,
    /// Unix timestamp of creation.
    pub created: u64,
    /// The owner of the model.
    pub owned_by: String,
}

/// Response from listing models.
#[derive(Debug, Clone, Deserialize)]
pub struct ModelsResponse {
    /// The object type.
    pub object: String,
    /// The list of models.
    pub data: Vec<ModelInfo>,
}
