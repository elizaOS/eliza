use serde::{Deserialize, Serialize};

/// Configuration for the Blooio service.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlooioConfig {
    pub api_key: String,
    pub api_base_url: String,
    pub webhook_secret: Option<String>,
    pub webhook_port: u16,
}

/// Target for a Blooio message — phone (E.164), email, or group ID.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "value")]
pub enum MessageTarget {
    Phone(String),
    Email(String),
    GroupId(String),
}

impl MessageTarget {
    /// Returns the raw chat identifier string.
    pub fn as_chat_id(&self) -> &str {
        match self {
            Self::Phone(p) => p,
            Self::Email(e) => e,
            Self::GroupId(g) => g,
        }
    }

    /// Parse a string into a `MessageTarget` based on its format.
    pub fn from_str(s: &str) -> Option<Self> {
        use crate::utils::{validate_email, validate_group_id, validate_phone};
        if validate_phone(s) {
            return Some(Self::Phone(s.to_string()));
        }
        if validate_email(s) {
            return Some(Self::Email(s.to_string()));
        }
        if validate_group_id(s) {
            return Some(Self::GroupId(s.to_string()));
        }
        None
    }
}

/// A Blooio message (outbound or inbound).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlooioMessage {
    pub target: MessageTarget,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

/// Response from the Blooio API after sending a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlooioResponse {
    #[serde(default)]
    pub success: bool,
    pub message_id: Option<String>,
    pub error: Option<String>,
}

/// A single entry in a conversation history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationEntry {
    pub role: String,
    pub text: String,
    pub timestamp: u64,
    pub chat_id: String,
}

/// An incoming webhook event from Blooio.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookEvent {
    pub event_type: String,
    pub chat_id: String,
    pub message: Option<String>,
    pub timestamp: u64,
    pub signature: Option<String>,
}

/// Errors produced by the Blooio plugin.
#[derive(Debug)]
pub enum BlooioError {
    ApiError { status: u16, body: String },
    NetworkError(String),
    ParseError(String),
    ValidationError(String),
}

impl std::fmt::Display for BlooioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ApiError { status, body } => {
                write!(f, "Blooio API error ({}): {}", status, body)
            }
            Self::NetworkError(msg) => write!(f, "Network error: {}", msg),
            Self::ParseError(msg) => write!(f, "Parse error: {}", msg),
            Self::ValidationError(msg) => write!(f, "Validation error: {}", msg),
        }
    }
}

impl std::error::Error for BlooioError {}
