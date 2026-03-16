//! Type definitions for the Twitch plugin.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Maximum message length for Twitch chat
pub const MAX_TWITCH_MESSAGE_LENGTH: usize = 500;

/// Service name constant
pub const TWITCH_SERVICE_NAME: &str = "twitch";

/// Event types emitted by the Twitch plugin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TwitchEventType {
    MessageReceived,
    MessageSent,
    JoinChannel,
    LeaveChannel,
    ConnectionReady,
    ConnectionLost,
}

impl TwitchEventType {
    /// Get the string representation of the event type
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MessageReceived => "TWITCH_MESSAGE_RECEIVED",
            Self::MessageSent => "TWITCH_MESSAGE_SENT",
            Self::JoinChannel => "TWITCH_JOIN_CHANNEL",
            Self::LeaveChannel => "TWITCH_LEAVE_CHANNEL",
            Self::ConnectionReady => "TWITCH_CONNECTION_READY",
            Self::ConnectionLost => "TWITCH_CONNECTION_LOST",
        }
    }
}

/// Twitch user roles for access control
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TwitchRole {
    Moderator,
    Owner,
    Vip,
    Subscriber,
    All,
}

/// Configuration settings for the Twitch plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchSettings {
    pub username: String,
    pub client_id: String,
    pub access_token: String,
    pub client_secret: Option<String>,
    pub refresh_token: Option<String>,
    pub channel: String,
    pub additional_channels: Vec<String>,
    pub require_mention: bool,
    pub allowed_roles: Vec<TwitchRole>,
    pub allowed_user_ids: Vec<String>,
    pub enabled: bool,
}

impl Default for TwitchSettings {
    fn default() -> Self {
        Self {
            username: String::new(),
            client_id: String::new(),
            access_token: String::new(),
            client_secret: None,
            refresh_token: None,
            channel: String::new(),
            additional_channels: Vec::new(),
            require_mention: false,
            allowed_roles: vec![TwitchRole::All],
            allowed_user_ids: Vec::new(),
            enabled: true,
        }
    }
}

/// Information about a Twitch user
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TwitchUserInfo {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    #[serde(default)]
    pub is_moderator: bool,
    #[serde(default)]
    pub is_broadcaster: bool,
    #[serde(default)]
    pub is_vip: bool,
    #[serde(default)]
    pub is_subscriber: bool,
    pub color: Option<String>,
    #[serde(default)]
    pub badges: HashMap<String, String>,
}

impl TwitchUserInfo {
    /// Get the best display name for this user
    pub fn display_name(&self) -> &str {
        if !self.display_name.is_empty() {
            &self.display_name
        } else {
            &self.username
        }
    }
}

/// Represents a Twitch chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchMessage {
    pub id: String,
    pub channel: String,
    pub text: String,
    pub user: TwitchUserInfo,
    pub timestamp: i64,
    #[serde(default)]
    pub is_action: bool,
    #[serde(default)]
    pub is_highlighted: bool,
    pub reply_to: Option<TwitchReplyInfo>,
}

/// Information about a reply
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchReplyInfo {
    pub message_id: String,
    pub user_id: String,
    pub username: String,
    pub text: String,
}

/// Options for sending a message
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TwitchMessageSendOptions {
    pub channel: Option<String>,
    pub reply_to: Option<String>,
}

/// Result from sending a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchSendResult {
    pub success: bool,
    pub message_id: Option<String>,
    pub error: Option<String>,
}

/// Twitch plugin errors
#[derive(Error, Debug)]
pub enum TwitchPluginError {
    #[error("Twitch service is not initialized")]
    ServiceNotInitialized,

    #[error("Twitch client is not connected")]
    NotConnected,

    #[error("Configuration error: {message}")]
    Configuration {
        message: String,
        setting_name: Option<String>,
    },

    #[error("Twitch API error: {message}")]
    Api {
        message: String,
        status_code: Option<u16>,
    },

    #[error("WebSocket error: {0}")]
    WebSocket(String),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Normalize a Twitch channel name (ensure no # prefix)
pub fn normalize_channel(channel: &str) -> String {
    channel.trim_start_matches('#').to_lowercase()
}

/// Format a channel name for display (with # prefix)
pub fn format_channel_for_display(channel: &str) -> String {
    let normalized = normalize_channel(channel);
    format!("#{}", normalized)
}

/// Get the best display name for a Twitch user
pub fn get_twitch_user_display_name(user: &TwitchUserInfo) -> String {
    user.display_name().to_string()
}

// Regex patterns for markdown stripping
static BOLD_PATTERN1: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*\*([^*]+)\*\*").unwrap());
static BOLD_PATTERN2: Lazy<Regex> = Lazy::new(|| Regex::new(r"__([^_]+)__").unwrap());
static ITALIC_PATTERN1: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*([^*]+)\*").unwrap());
static ITALIC_PATTERN2: Lazy<Regex> = Lazy::new(|| Regex::new(r"_([^_]+)_").unwrap());
static STRIKETHROUGH_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"~~([^~]+)~~").unwrap());
static CODE_INLINE_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"`([^`]+)`").unwrap());
static CODE_BLOCK_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"```[\s\S]*?```").unwrap());
static LINK_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[([^\]]+)\]\([^)]+\)").unwrap());
static HEADER_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^#{1,6}\s+").unwrap());
static BLOCKQUOTE_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^>\s+").unwrap());
static LIST_PATTERN1: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^[-*+]\s+").unwrap());
static LIST_PATTERN2: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^\d+\.\s+").unwrap());
static NEWLINES_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());

/// Strip markdown formatting for Twitch chat display
pub fn strip_markdown_for_twitch(text: &str) -> String {
    let mut result = text.to_string();
    
    result = BOLD_PATTERN1.replace_all(&result, "$1").to_string();
    result = BOLD_PATTERN2.replace_all(&result, "$1").to_string();
    result = ITALIC_PATTERN1.replace_all(&result, "$1").to_string();
    result = ITALIC_PATTERN2.replace_all(&result, "$1").to_string();
    result = STRIKETHROUGH_PATTERN.replace_all(&result, "$1").to_string();
    result = CODE_INLINE_PATTERN.replace_all(&result, "$1").to_string();
    result = CODE_BLOCK_PATTERN.replace_all(&result, "[code block]").to_string();
    result = LINK_PATTERN.replace_all(&result, "$1").to_string();
    result = HEADER_PATTERN.replace_all(&result, "").to_string();
    result = BLOCKQUOTE_PATTERN.replace_all(&result, "").to_string();
    result = LIST_PATTERN1.replace_all(&result, "• ").to_string();
    result = LIST_PATTERN2.replace_all(&result, "• ").to_string();
    result = NEWLINES_PATTERN.replace_all(&result, "\n\n").to_string();
    
    result.trim().to_string()
}

/// Split a message into chunks that fit Twitch's message limit
pub fn split_message_for_twitch(text: &str, max_length: usize) -> Vec<String> {
    if text.len() <= max_length {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text.to_string();

    while !remaining.is_empty() {
        if remaining.len() <= max_length {
            chunks.push(remaining);
            break;
        }

        // Try to split at a sentence boundary
        let mut split_index = remaining[..max_length].rfind(". ");
        if split_index.is_none() || split_index.unwrap() < max_length / 2 {
            // Try to split at a word boundary
            split_index = remaining[..max_length].rfind(' ');
        }
        if split_index.is_none() || split_index.unwrap() < max_length / 2 {
            // Force split at max length
            split_index = Some(max_length);
        }

        let idx = split_index.unwrap();
        chunks.push(remaining[..idx].trim().to_string());
        remaining = remaining[idx..].trim().to_string();
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_channel() {
        assert_eq!(normalize_channel("#mychannel"), "mychannel");
        assert_eq!(normalize_channel("mychannel"), "mychannel");
        assert_eq!(normalize_channel("#MyChannel"), "mychannel");
    }

    #[test]
    fn test_format_channel_for_display() {
        assert_eq!(format_channel_for_display("mychannel"), "#mychannel");
        assert_eq!(format_channel_for_display("#mychannel"), "#mychannel");
    }

    #[test]
    fn test_strip_markdown() {
        assert_eq!(strip_markdown_for_twitch("**bold**"), "bold");
        assert_eq!(strip_markdown_for_twitch("_italic_"), "italic");
        assert_eq!(strip_markdown_for_twitch("[link](url)"), "link");
    }

    #[test]
    fn test_split_message() {
        let short = "Hello world";
        assert_eq!(split_message_for_twitch(short, 500), vec!["Hello world"]);

        let long = "a".repeat(600);
        let chunks = split_message_for_twitch(&long, 500);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].len() <= 500);
    }
}
