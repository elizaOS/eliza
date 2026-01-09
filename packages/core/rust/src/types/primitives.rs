//! Primitive types for elizaOS
//!
//! Contains UUID, Content, Media, and other fundamental types.

use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use thiserror::Error;

lazy_static! {
    static ref UUID_REGEX: Regex =
        Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap();
}

/// Error type for UUID operations
#[derive(Error, Debug)]
pub enum UUIDError {
    /// Invalid UUID format
    #[error("Invalid UUID format: {0}")]
    InvalidFormat(String),
}

/// A universally unique identifier (UUID) type
///
/// This type wraps a String and validates that it conforms to the UUID format.
/// It serializes transparently as a string in JSON.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UUID(String);

impl UUID {
    /// Create a new UUID from a string, validating the format
    pub fn new(id: &str) -> Result<Self, UUIDError> {
        if !UUID_REGEX.is_match(&id.to_lowercase()) {
            return Err(UUIDError::InvalidFormat(id.to_string()));
        }
        Ok(UUID(id.to_lowercase()))
    }

    /// Create a new random UUID (v4)
    pub fn new_v4() -> Self {
        UUID(uuid::Uuid::new_v4().to_string())
    }

    /// Get the string representation
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Convert to owned String
    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for UUID {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl TryFrom<&str> for UUID {
    type Error = UUIDError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        UUID::new(value)
    }
}

impl TryFrom<String> for UUID {
    type Error = UUIDError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        UUID::new(&value)
    }
}

impl From<uuid::Uuid> for UUID {
    fn from(value: uuid::Uuid) -> Self {
        UUID(value.to_string())
    }
}

/// Helper function to safely cast a string to strongly typed UUID
pub fn as_uuid(id: &str) -> Result<UUID, UUIDError> {
    UUID::new(id)
}

/// Content type enumeration for media
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    /// Image content
    Image,
    /// Video content
    Video,
    /// Audio content
    Audio,
    /// Document content
    Document,
    /// Link content
    Link,
}

/// Represents a media attachment
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    /// Unique identifier
    pub id: String,
    /// Media URL
    pub url: String,
    /// Media title
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Media source
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Media description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Text content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Content type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<ContentType>,
}

/// Platform-provided metadata about mentions
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionContext {
    /// Platform native mention (@Discord, @Telegram, etc.)
    pub is_mention: bool,
    /// Reply to agent's message
    pub is_reply: bool,
    /// In a thread with agent
    pub is_thread: bool,
    /// Platform-specific mention type for debugging/logging
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_type: Option<MentionType>,
}

/// Types of mentions
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MentionType {
    /// Platform native mention
    PlatformMention,
    /// Reply to a message
    Reply,
    /// Thread reply
    Thread,
    /// No mention
    None,
}

/// Represents the content of a memory, message, or other information
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    /// The agent's internal thought process
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought: Option<String>,
    /// The main text content visible to users
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Optional actions to be performed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    /// Optional providers to use for context generation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<String>>,
    /// Optional source/origin of the content
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Optional target/destination for responses
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// URL of the original message/post
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// UUID of parent message if this is a reply/thread
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<UUID>,
    /// Array of media attachments
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Media>>,
    /// Channel type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_type: Option<super::ChannelType>,
    /// Platform-provided metadata about mentions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_context: Option<MentionContext>,
    /// Internal message ID used for streaming coordination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_message_id: Option<UUID>,
    /// Additional dynamic properties
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A generic type for metadata objects
pub type Metadata = HashMap<String, serde_json::Value>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uuid_validation() {
        // Valid UUID
        let valid = UUID::new("550e8400-e29b-41d4-a716-446655440000");
        assert!(valid.is_ok());

        // Invalid UUID
        let invalid = UUID::new("not-a-uuid");
        assert!(invalid.is_err());
    }

    #[test]
    fn test_uuid_v4_generation() {
        let uuid = UUID::new_v4();
        assert!(UUID_REGEX.is_match(uuid.as_str()));
    }

    #[test]
    fn test_content_serialization() {
        let content = Content {
            text: Some("Hello, world!".to_string()),
            ..Default::default()
        };

        let json = serde_json::to_string(&content).unwrap();
        assert!(json.contains("\"text\":\"Hello, world!\""));

        // Ensure camelCase
        let content2 = Content {
            in_reply_to: Some(UUID::new_v4()),
            ..Default::default()
        };
        let json2 = serde_json::to_string(&content2).unwrap();
        assert!(json2.contains("\"inReplyTo\""));
    }
}
