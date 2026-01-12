//! Primitive types for elizaOS
//!
//! Contains UUID, Content, Media, and other fundamental types.

use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
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

/// The default UUID used when no room or world is specified.
/// This is the nil/zero UUID (00000000-0000-0000-0000-000000000000).
/// Using this allows users to spin up an AgentRuntime without worrying about room/world setup.
pub const DEFAULT_UUID_STR: &str = "00000000-0000-0000-0000-000000000000";

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

    /// Get the default UUID (nil/zero UUID).
    /// Use this when no specific room or world is needed.
    pub fn default_uuid() -> Self {
        UUID(DEFAULT_UUID_STR.to_string())
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

/// Converts a string or number to a deterministic UUID.
///
/// This matches the TypeScript implementation (`stringToUuid`) exactly:
/// - If the input is already a UUID, it is returned as-is (normalized to lowercase).
/// - Otherwise, `encodeURIComponent` is applied to the input string.
/// - The UUID is derived from the first 16 bytes of SHA-1(escapedStr).
/// - RFC4122 variant bits are set, and the version nibble is set to `0x0` (custom).
pub fn string_to_uuid<T: ToString>(target: T) -> UUID {
    let s = target.to_string();

    // If already a UUID, return as-is to avoid re-hashing (matches TS behavior)
    if let Ok(existing) = UUID::new(&s) {
        return existing;
    }

    let escaped = encode_uri_component(&s);
    let digest = Sha1::digest(escaped.as_bytes()); // 20 bytes

    let mut bytes: [u8; 16] = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);

    // Set RFC4122 variant bits: 10xxxxxx
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    // Set custom version nibble to 0x0 (matches TS tests expecting version 0)
    // Clear the high nibble, leaving version as 0
    bytes[6] &= 0x0f;

    UUID(uuid::Uuid::from_bytes(bytes).to_string())
}

fn encode_uri_component(input: &str) -> String {
    // JS encodeURIComponent leaves these bytes unescaped:
    // A-Z a-z 0-9 - _ . ! ~ * ' ( )
    let mut out = String::with_capacity(input.len());
    for &b in input.as_bytes() {
        if is_encode_uri_component_unescaped(b) {
            out.push(b as char);
        } else {
            // Uppercase hex matches JS output.
            out.push('%');
            out.push(nibble_to_hex_upper(b >> 4));
            out.push(nibble_to_hex_upper(b & 0x0f));
        }
    }
    out
}

#[inline]
fn is_encode_uri_component_unescaped(b: u8) -> bool {
    matches!(
        b,
        b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')'
    )
}

#[inline]
fn nibble_to_hex_upper(n: u8) -> char {
    debug_assert!(n < 16);
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'A' + (n - 10)) as char,
        _ => '0',
    }
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

/// Represents the content of a memory, message, or other information.
///
/// This is the primary data structure for messages exchanged between
/// users, agents, and the system.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    /// The agent's internal thought process
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought: Option<String>,
    /// The main text content visible to users
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Actions to be performed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    /// Providers to use for context generation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<String>>,
    /// Source/origin of the content (e.g., 'discord', 'telegram')
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Target/destination for responses
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
    /// Channel type where this content was sent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_type: Option<super::environment::ChannelType>,
    /// Platform-provided metadata about mentions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_context: Option<MentionContext>,
    /// Internal message ID used for streaming coordination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_message_id: Option<UUID>,
    /// Response ID for message tracking
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<UUID>,
    /// Whether this is a simple response (no actions required)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simple: Option<bool>,
    /// Results from action callbacks
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_callbacks: Option<Box<Content>>,
    /// Results from evaluator callbacks
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_callbacks: Option<Box<Content>>,
    /// Type marker for internal use
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
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
    fn test_default_uuid() {
        // Test that DEFAULT_UUID_STR is the nil/zero UUID
        assert_eq!(DEFAULT_UUID_STR, "00000000-0000-0000-0000-000000000000");

        // Test UUID::default_uuid() returns the correct UUID
        let default = UUID::default_uuid();
        assert_eq!(default.as_str(), DEFAULT_UUID_STR);

        // Should be a valid UUID format
        assert!(UUID::new(DEFAULT_UUID_STR).is_ok());
    }

    #[test]
    fn test_default_uuid_can_be_used_in_content() {
        // Test that DEFAULT_UUID can be used where UUIDs are expected
        let content = Content {
            in_reply_to: Some(UUID::default_uuid()),
            ..Default::default()
        };
        assert_eq!(content.in_reply_to.unwrap().as_str(), DEFAULT_UUID_STR);
    }

    #[test]
    fn test_string_to_uuid_known_vectors() {
        // These are the canonical TypeScript test vectors from
        // `packages/typescript/typescript/src/__tests__/utils/stringToUuid.test.ts`.
        let vectors = [
            ("test", "a94a8fe5-ccb1-0ba6-9c4c-0873d391e987"),
            ("hello world", "f0355dd5-2823-054c-ae66-a0b12842c215"),
            ("", "da39a3ee-5e6b-0b0d-b255-bfef95601890"),
            ("123", "40bd0015-6308-0fc3-9165-329ea1ff5c5e"),
            ("user:agent", "a49810ce-da30-0d3b-97ee-d4d47774d8af"),
        ];

        for (input, expected) in vectors {
            let actual = string_to_uuid(input);
            assert_eq!(actual.as_str(), expected);
        }
    }

    #[test]
    fn test_string_to_uuid_returns_existing_uuid_unchanged() {
        let existing = "550e8400-e29b-41d4-a716-446655440000";
        let result = string_to_uuid(existing);
        assert_eq!(result.as_str(), existing);
    }

    #[test]
    fn test_string_to_uuid_sets_format_bits() {
        let uuid = string_to_uuid("test");

        let parts: Vec<&str> = uuid.as_str().split('-').collect();
        assert_eq!(parts.len(), 5);

        // Variant bits: 10xxxxxx in first byte of 4th segment (index 3)
        let variant_byte = u8::from_str_radix(&parts[3][0..2], 16).unwrap();
        assert_eq!(variant_byte & 0xc0, 0x80);

        // Version nibble: first hex digit of 3rd segment (index 2) should be 0
        let version_nibble = u8::from_str_radix(&parts[2][0..1], 16).unwrap();
        assert_eq!(version_nibble, 0);
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
