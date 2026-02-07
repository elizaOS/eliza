//! Type definitions for the Signal plugin.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Maximum message length for Signal
pub const MAX_SIGNAL_MESSAGE_LENGTH: usize = 2000;

/// Maximum attachment size (100MB)
pub const MAX_SIGNAL_ATTACHMENT_SIZE: usize = 100 * 1024 * 1024;

/// Service name constant
pub const SIGNAL_SERVICE_NAME: &str = "signal";

// Validation regexes
static E164_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\+[1-9]\d{1,14}$").unwrap());

static UUID_PATTERN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .unwrap()
});

static GROUP_ID_PATTERN: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9+/]+=*$").unwrap());

/// Event types emitted by the Signal plugin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SignalEventType {
    MessageReceived,
    MessageSent,
    ReactionReceived,
    GroupJoined,
    GroupLeft,
    TypingStarted,
    TypingStopped,
    ContactUpdated,
}

impl SignalEventType {
    /// Get the string representation of the event type
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MessageReceived => "SIGNAL_MESSAGE_RECEIVED",
            Self::MessageSent => "SIGNAL_MESSAGE_SENT",
            Self::ReactionReceived => "SIGNAL_REACTION_RECEIVED",
            Self::GroupJoined => "SIGNAL_GROUP_JOINED",
            Self::GroupLeft => "SIGNAL_GROUP_LEFT",
            Self::TypingStarted => "SIGNAL_TYPING_STARTED",
            Self::TypingStopped => "SIGNAL_TYPING_STOPPED",
            Self::ContactUpdated => "SIGNAL_CONTACT_UPDATED",
        }
    }
}

/// Configuration settings for the Signal plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalSettings {
    pub account_number: String,
    pub http_url: Option<String>,
    pub cli_path: Option<String>,
    pub should_ignore_group_messages: bool,
    pub poll_interval_ms: u64,
    pub typing_indicator_enabled: bool,
}

impl Default for SignalSettings {
    fn default() -> Self {
        Self {
            account_number: String::new(),
            http_url: None,
            cli_path: None,
            should_ignore_group_messages: false,
            poll_interval_ms: 1000,
            typing_indicator_enabled: true,
        }
    }
}

/// Represents a Signal message attachment
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalAttachment {
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default)]
    pub voice_note: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// Represents a quoted message in Signal
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalQuote {
    /// Timestamp of quoted message
    pub id: i64,
    /// Phone number of quoted message author
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub attachments: Vec<SignalAttachment>,
}

/// Information about a reaction on a Signal message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalReactionInfo {
    pub emoji: String,
    pub target_author: String,
    pub target_sent_timestamp: i64,
    #[serde(default)]
    pub is_remove: bool,
}

/// Represents a Signal message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalMessage {
    pub timestamp: i64,
    /// Sender phone number
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_device: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default)]
    pub attachments: Vec<SignalAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<SignalQuote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reaction: Option<SignalReactionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in_seconds: Option<i32>,
    #[serde(default)]
    pub is_view_once: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<HashMap<String, serde_json::Value>>,
}

/// Represents a Signal contact
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalContact {
    pub number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub given_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub blocked: bool,
    #[serde(default)]
    pub message_expiration_time: i32,
}

impl SignalContact {
    /// Get the best display name for this contact
    pub fn display_name(&self) -> String {
        if let Some(name) = &self.name {
            if !name.is_empty() {
                return name.clone();
            }
        }
        if let Some(profile_name) = &self.profile_name {
            if !profile_name.is_empty() {
                return profile_name.clone();
            }
        }
        if let Some(given_name) = &self.given_name {
            if !given_name.is_empty() {
                if let Some(family_name) = &self.family_name {
                    if !family_name.is_empty() {
                        return format!("{} {}", given_name, family_name);
                    }
                }
                return given_name.clone();
            }
        }
        self.number.clone()
    }
}

/// Represents a member of a Signal group
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalGroupMember {
    pub uuid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(default = "default_role")]
    pub role: String,
}

fn default_role() -> String {
    "DEFAULT".to_string()
}

/// Represents a Signal group
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalGroup {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub members: Vec<SignalGroupMember>,
    #[serde(default)]
    pub pending_members: Vec<SignalGroupMember>,
    #[serde(default)]
    pub requesting_members: Vec<SignalGroupMember>,
    #[serde(default)]
    pub admins: Vec<SignalGroupMember>,
    #[serde(default)]
    pub is_blocked: bool,
    #[serde(default = "default_true")]
    pub is_member: bool,
    #[serde(default)]
    pub message_expiration_time: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_link: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Options for sending a Signal message
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalMessageSendOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote_author: Option<String>,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<HashMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_style: Option<Vec<HashMap<String, serde_json::Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_title: Option<String>,
}

/// Result of sending a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub timestamp: i64,
}

/// Result of sending a reaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionResult {
    pub success: bool,
}

/// Signal plugin errors
#[derive(Error, Debug)]
pub enum SignalPluginError {
    #[error("Signal service is not initialized")]
    ServiceNotInitialized,

    #[error("Signal client is not available")]
    ClientNotAvailable,

    #[error("Configuration error: {message}")]
    Configuration {
        message: String,
        setting_name: Option<String>,
    },

    #[error("Signal API error: {message} (status: {status_code:?})")]
    Api {
        message: String,
        status_code: Option<u16>,
        response_body: Option<String>,
    },

    #[error("Invalid phone number: {0}")]
    InvalidPhoneNumber(String),

    #[error("Invalid group ID: {0}")]
    InvalidGroupId(String),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("URL parse error: {0}")]
    UrlParse(#[from] url::ParseError),
}

/// Validate if a string is a valid E.164 phone number
pub fn is_valid_e164(phone: &str) -> bool {
    E164_PATTERN.is_match(phone)
}

/// Normalize a phone number to E.164 format
pub fn normalize_e164(phone: &str) -> Option<String> {
    if phone.is_empty() {
        return None;
    }

    // Remove whitespace and common separators
    let cleaned: String = phone
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '.' && *c != '(' && *c != ')' && *c != '[' && *c != ']')
        .collect();

    // Add + if missing
    let with_plus = if cleaned.starts_with('+') {
        cleaned
    } else {
        format!("+{}", cleaned)
    };

    // Validate
    if is_valid_e164(&with_plus) {
        Some(with_plus)
    } else {
        None
    }
}

/// Validate if a string is a valid UUID v4
pub fn is_valid_uuid(uuid_str: &str) -> bool {
    UUID_PATTERN.is_match(uuid_str)
}

/// Validate if a string appears to be a valid Signal group ID (base64)
pub fn is_valid_group_id(group_id: &str) -> bool {
    if group_id.len() < 20 {
        return false;
    }
    GROUP_ID_PATTERN.is_match(group_id)
}

/// Get the display name for a Signal contact
pub fn get_signal_contact_display_name(contact: &SignalContact) -> String {
    contact.display_name()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_e164() {
        assert!(is_valid_e164("+14155551234"));
        assert!(is_valid_e164("+1234567890"));
        assert!(!is_valid_e164("14155551234"));
        assert!(!is_valid_e164("+0123456789"));
        assert!(!is_valid_e164(""));
    }

    #[test]
    fn test_normalize_e164() {
        assert_eq!(normalize_e164("+14155551234"), Some("+14155551234".to_string()));
        assert_eq!(normalize_e164("14155551234"), Some("+14155551234".to_string()));
        assert_eq!(normalize_e164("+1 (415) 555-1234"), Some("+14155551234".to_string()));
        assert_eq!(normalize_e164("invalid"), None);
        assert_eq!(normalize_e164(""), None);
    }

    #[test]
    fn test_is_valid_group_id() {
        assert!(is_valid_group_id("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="));
        assert!(!is_valid_group_id("short"));
        assert!(!is_valid_group_id(""));
    }

    #[test]
    fn test_contact_display_name() {
        let contact = SignalContact {
            number: "+14155551234".to_string(),
            name: Some("John Doe".to_string()),
            ..Default::default()
        };
        assert_eq!(contact.display_name(), "John Doe");

        let contact2 = SignalContact {
            number: "+14155551234".to_string(),
            profile_name: Some("Johnny".to_string()),
            ..Default::default()
        };
        assert_eq!(contact2.display_name(), "Johnny");

        let contact3 = SignalContact {
            number: "+14155551234".to_string(),
            ..Default::default()
        };
        assert_eq!(contact3.display_name(), "+14155551234");
    }
}
