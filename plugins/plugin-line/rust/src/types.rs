//! Type definitions for the LINE plugin.

use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Maximum message length for LINE
pub const MAX_LINE_MESSAGE_LENGTH: usize = 5000;

/// Maximum messages per batch
pub const MAX_LINE_BATCH_SIZE: usize = 5;

/// LINE service name
pub const LINE_SERVICE_NAME: &str = "line";

lazy_static! {
    /// Pattern for validating LINE user IDs (U followed by 32 hex characters)
    static ref USER_ID_PATTERN: Regex =
        Regex::new(r"^U[a-fA-F0-9]{32}$").unwrap();

    /// Pattern for validating LINE group IDs (C followed by 32 hex characters)
    static ref GROUP_ID_PATTERN: Regex =
        Regex::new(r"^C[a-fA-F0-9]{32}$").unwrap();

    /// Pattern for validating LINE room IDs (R followed by 32 hex characters)
    static ref ROOM_ID_PATTERN: Regex =
        Regex::new(r"^R[a-fA-F0-9]{32}$").unwrap();

    /// Pattern for removing LINE prefixes
    static ref LINE_PREFIX_PATTERN: Regex =
        Regex::new(r"(?i)^line:(group|room|user):").unwrap();

    /// Pattern for simple LINE prefix
    static ref SIMPLE_PREFIX_PATTERN: Regex =
        Regex::new(r"(?i)^line:").unwrap();
}

/// Event types emitted by the LINE plugin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineEventType {
    MessageReceived,
    MessageSent,
    Follow,
    Unfollow,
    JoinGroup,
    LeaveGroup,
    Postback,
    WebhookVerified,
    ConnectionReady,
}

impl std::fmt::Display for LineEventType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LineEventType::MessageReceived => write!(f, "LINE_MESSAGE_RECEIVED"),
            LineEventType::MessageSent => write!(f, "LINE_MESSAGE_SENT"),
            LineEventType::Follow => write!(f, "LINE_FOLLOW"),
            LineEventType::Unfollow => write!(f, "LINE_UNFOLLOW"),
            LineEventType::JoinGroup => write!(f, "LINE_JOIN_GROUP"),
            LineEventType::LeaveGroup => write!(f, "LINE_LEAVE_GROUP"),
            LineEventType::Postback => write!(f, "LINE_POSTBACK"),
            LineEventType::WebhookVerified => write!(f, "LINE_WEBHOOK_VERIFIED"),
            LineEventType::ConnectionReady => write!(f, "LINE_CONNECTION_READY"),
        }
    }
}

/// LINE chat types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineChatType {
    User,
    Group,
    Room,
}

impl std::fmt::Display for LineChatType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LineChatType::User => write!(f, "user"),
            LineChatType::Group => write!(f, "group"),
            LineChatType::Room => write!(f, "room"),
        }
    }
}

/// Configuration settings for the LINE plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineSettings {
    pub channel_access_token: String,
    pub channel_secret: String,
    pub webhook_path: String,
    pub dm_policy: String,
    pub group_policy: String,
    pub allow_from: Vec<String>,
    pub enabled: bool,
}

impl Default for LineSettings {
    fn default() -> Self {
        Self {
            channel_access_token: String::new(),
            channel_secret: String::new(),
            webhook_path: "/webhooks/line".to_string(),
            dm_policy: "pairing".to_string(),
            group_policy: "allowlist".to_string(),
            allow_from: Vec::new(),
            enabled: true,
        }
    }
}

/// LINE user profile
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineUser {
    pub user_id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// LINE group/room info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineGroup {
    pub group_id: String,
    pub group_type: LineChatType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u32>,
}

/// LINE message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineMessage {
    pub id: String,
    pub message_type: String,
    pub user_id: String,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_token: Option<String>,
}

/// Result from sending a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineSendResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LineSendResult {
    pub fn success(message_id: String, chat_id: String) -> Self {
        Self {
            success: true,
            message_id: Some(message_id),
            chat_id: Some(chat_id),
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            message_id: None,
            chat_id: None,
            error: Some(error.into()),
        }
    }
}

/// Flex message content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineFlexMessage {
    pub alt_text: String,
    pub contents: serde_json::Value,
}

/// Template message content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineTemplateMessage {
    pub template_type: String,
    pub alt_text: String,
    pub template: serde_json::Value,
}

/// Location message content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineLocationMessage {
    pub title: String,
    pub address: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// Error types for the LINE plugin
#[derive(Error, Debug)]
pub enum LinePluginError {
    #[error("Configuration error: {message}")]
    Configuration {
        message: String,
        setting: Option<String>,
    },

    #[error("API error: {message}")]
    Api {
        message: String,
        status_code: Option<u16>,
    },

    #[error("Service not initialized")]
    NotInitialized,

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl LinePluginError {
    pub fn configuration(message: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: None,
        }
    }

    pub fn configuration_with_setting(message: impl Into<String>, setting: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: Some(setting.into()),
        }
    }

    pub fn api(message: impl Into<String>) -> Self {
        Self::Api {
            message: message.into(),
            status_code: None,
        }
    }

    pub fn api_with_status(message: impl Into<String>, status_code: u16) -> Self {
        Self::Api {
            message: message.into(),
            status_code: Some(status_code),
        }
    }
}

// Utility functions

/// Check if a string is a valid LINE user ID (U followed by 32 hex chars)
pub fn is_valid_line_user_id(id: &str) -> bool {
    USER_ID_PATTERN.is_match(id.trim())
}

/// Check if a string is a valid LINE group ID (C followed by 32 hex chars)
pub fn is_valid_line_group_id(id: &str) -> bool {
    GROUP_ID_PATTERN.is_match(id.trim())
}

/// Check if a string is a valid LINE room ID (R followed by 32 hex chars)
pub fn is_valid_line_room_id(id: &str) -> bool {
    ROOM_ID_PATTERN.is_match(id.trim())
}

/// Check if a string is any valid LINE ID
pub fn is_valid_line_id(id: &str) -> bool {
    let trimmed = id.trim();
    is_valid_line_user_id(trimmed)
        || is_valid_line_group_id(trimmed)
        || is_valid_line_room_id(trimmed)
}

/// Normalize a LINE target ID (strip prefixes)
pub fn normalize_line_target(target: &str) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Remove line: prefixes
    let result = LINE_PREFIX_PATTERN.replace(trimmed, "");
    let result = SIMPLE_PREFIX_PATTERN.replace(&result, "");

    Some(result.to_string())
}

/// Determine the chat type from an ID
pub fn get_chat_type_from_id(id: &str) -> Option<LineChatType> {
    let trimmed = id.trim();
    if is_valid_line_user_id(trimmed) {
        Some(LineChatType::User)
    } else if is_valid_line_group_id(trimmed) {
        Some(LineChatType::Group)
    } else if is_valid_line_room_id(trimmed) {
        Some(LineChatType::Room)
    } else {
        None
    }
}

/// Split text for LINE messages
pub fn split_message_for_line(text: &str, max_length: Option<usize>) -> Vec<String> {
    let max_len = max_length.unwrap_or(MAX_LINE_MESSAGE_LENGTH);

    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Find break point
        let mut break_point = max_len;

        // Try newline first
        if let Some(idx) = remaining[..max_len].rfind('\n') {
            if idx > max_len / 2 {
                break_point = idx + 1;
            }
        } else if let Some(idx) = remaining[..max_len].rfind(' ') {
            // Try space
            if idx > max_len / 2 {
                break_point = idx + 1;
            }
        }

        chunks.push(remaining[..break_point].trim_end().to_string());
        remaining = remaining[break_point..].trim_start();
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_user_id() {
        assert!(is_valid_line_user_id("U1234567890abcdef1234567890abcdef"));
        assert!(!is_valid_line_user_id("C1234567890abcdef1234567890abcdef"));
        assert!(!is_valid_line_user_id("invalid"));
    }

    #[test]
    fn test_is_valid_group_id() {
        assert!(is_valid_line_group_id("C1234567890abcdef1234567890abcdef"));
        assert!(!is_valid_line_group_id("U1234567890abcdef1234567890abcdef"));
    }

    #[test]
    fn test_split_message() {
        let short = "Hello";
        assert_eq!(split_message_for_line(short, None), vec!["Hello"]);

        let long = "a".repeat(6000);
        let chunks = split_message_for_line(&long, Some(1000));
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.len() <= 1000));
    }
}
