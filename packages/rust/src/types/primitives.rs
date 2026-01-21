//! Primitive types for elizaOS (proto-backed)

use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fmt;
use std::hash::{Hash, Hasher};
use thiserror::Error;

use super::generated::eliza::v1::Uuid;

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

/// UUID type is proto-backed (Uuid message)
pub type UUID = Uuid;

/// The default UUID used when no room or world is specified
pub const DEFAULT_UUID_STR: &str = "00000000-0000-0000-0000-000000000000";

impl Uuid {
    /// Create a new UUID from a string, validating the format
    pub fn new(id: &str) -> Result<Self, UUIDError> {
        if !UUID_REGEX.is_match(&id.to_lowercase()) {
            return Err(UUIDError::InvalidFormat(id.to_string()));
        }
        Ok(Uuid {
            value: id.to_lowercase(),
        })
    }

    /// Create a new random UUID (v4)
    pub fn new_v4() -> Self {
        Uuid {
            value: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// Get the default UUID (nil/zero UUID).
    pub fn default_uuid() -> Self {
        Uuid {
            value: DEFAULT_UUID_STR.to_string(),
        }
    }

    /// Get the string representation
    pub fn as_str(&self) -> &str {
        &self.value
    }

    /// Convert to owned String
    pub fn into_string(self) -> String {
        self.value
    }
}

impl fmt::Display for Uuid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.value)
    }
}

impl Eq for Uuid {}

impl Hash for Uuid {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.value.hash(state);
    }
}

impl Serialize for Uuid {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.value)
    }
}

impl<'de> Deserialize<'de> for Uuid {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Uuid::new(&value).map_err(serde::de::Error::custom)
    }
}

impl TryFrom<&str> for Uuid {
    type Error = UUIDError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Uuid::new(value)
    }
}

impl TryFrom<String> for Uuid {
    type Error = UUIDError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Uuid::new(&value)
    }
}

impl From<uuid::Uuid> for Uuid {
    fn from(value: uuid::Uuid) -> Self {
        Uuid {
            value: value.to_string(),
        }
    }
}

/// Helper function to safely cast a string to strongly typed UUID
pub fn as_uuid(id: &str) -> Result<Uuid, UUIDError> {
    Uuid::new(id)
}

/// Converts a string or number to a deterministic UUID.
///
/// Matches the TypeScript implementation (`stringToUuid`) exactly.
pub fn string_to_uuid<T: ToString>(target: T) -> Uuid {
    let s = target.to_string();

    if let Ok(existing) = Uuid::new(&s) {
        return existing;
    }

    let escaped = encode_uri_component(&s);
    let digest = Sha1::digest(escaped.as_bytes()); // 20 bytes

    let mut bytes: [u8; 16] = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    bytes[6] &= 0x0F;

    let uuid = uuid::Uuid::from_bytes(bytes);
    Uuid {
        value: uuid.to_string(),
    }
}

/// Characters that should NOT be encoded by encodeURIComponent (matching JavaScript behavior)
const URI_COMPONENT_ENCODE_SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// Encode a string in the same way as JavaScript's encodeURIComponent
fn encode_uri_component(input: &str) -> String {
    percent_encoding::utf8_percent_encode(input, URI_COMPONENT_ENCODE_SET).to_string()
}

pub use super::generated::eliza::v1::DefaultUuid;

/// Channel types for messaging
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Default)]
pub enum ChannelType {
    /// Direct message to self
    #[serde(rename = "SELF")]
    SELF,
    /// Direct message (1:1)
    #[serde(rename = "DM")]
    #[default]
    DM,
    /// Group chat
    #[serde(rename = "GROUP")]
    GROUP,
    /// Voice direct message
    #[serde(rename = "VOICE_DM")]
    VoiceDm,
    /// Voice group
    #[serde(rename = "VOICE_GROUP")]
    VoiceGroup,
    /// Feed/timeline
    #[serde(rename = "FEED")]
    FEED,
    /// Thread conversation
    #[serde(rename = "THREAD")]
    THREAD,
    /// World chat
    #[serde(rename = "WORLD")]
    WORLD,
    /// Forum channel
    #[serde(rename = "FORUM")]
    FORUM,
    /// API channel
    #[serde(rename = "API")]
    API,
}

impl std::fmt::Display for ChannelType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChannelType::SELF => write!(f, "SELF"),
            ChannelType::DM => write!(f, "DM"),
            ChannelType::GROUP => write!(f, "GROUP"),
            ChannelType::VoiceDm => write!(f, "VOICE_DM"),
            ChannelType::VoiceGroup => write!(f, "VOICE_GROUP"),
            ChannelType::FEED => write!(f, "FEED"),
            ChannelType::THREAD => write!(f, "THREAD"),
            ChannelType::WORLD => write!(f, "WORLD"),
            ChannelType::FORUM => write!(f, "FORUM"),
            ChannelType::API => write!(f, "API"),
        }
    }
}

/// Flexible metadata container used across types.
pub type Metadata = serde_json::Value;

/// Mention context payload (platform-specific).
pub type MentionContext = serde_json::Value;

/// Media attachment payload (platform-specific).
pub type Media = serde_json::Value;

/// Content payload for messages and memories.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    /// Internal reasoning or thought process.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought: Option<String>,
    /// Main text content of the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Actions to execute with this content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    /// Providers used to generate this content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub providers: Option<Vec<String>>,
    /// Source platform or origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Target destination or recipient.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Associated URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// ID of the message this is replying to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    /// Media attachments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Media>>,
    /// Type of channel (e.g., "dm", "group").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_type: Option<String>,
    /// Platform-specific mention context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention_context: Option<MentionContext>,
    /// ID of the response message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_message_id: Option<String>,
    /// Response identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_id: Option<String>,
    /// Whether this is a simple response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simple: Option<bool>,
    /// Content type identifier.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// Structured data payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Additional extensible fields.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}
