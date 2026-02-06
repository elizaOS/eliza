//! Type definitions for the Google Chat plugin.

use regex::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Maximum message length for Google Chat
pub const MAX_GOOGLE_CHAT_MESSAGE_LENGTH: usize = 4000;

/// Google Chat service name
pub const GOOGLE_CHAT_SERVICE_NAME: &str = "google-chat";

/// Event types emitted by the Google Chat plugin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum GoogleChatEventType {
    MessageReceived,
    MessageSent,
    SpaceJoined,
    SpaceLeft,
    ReactionReceived,
    ReactionSent,
    WebhookReady,
    ConnectionReady,
}

impl GoogleChatEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MessageReceived => "GOOGLE_CHAT_MESSAGE_RECEIVED",
            Self::MessageSent => "GOOGLE_CHAT_MESSAGE_SENT",
            Self::SpaceJoined => "GOOGLE_CHAT_SPACE_JOINED",
            Self::SpaceLeft => "GOOGLE_CHAT_SPACE_LEFT",
            Self::ReactionReceived => "GOOGLE_CHAT_REACTION_RECEIVED",
            Self::ReactionSent => "GOOGLE_CHAT_REACTION_SENT",
            Self::WebhookReady => "GOOGLE_CHAT_WEBHOOK_READY",
            Self::ConnectionReady => "GOOGLE_CHAT_CONNECTION_READY",
        }
    }
}

/// Audience type for token verification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoogleChatAudienceType {
    AppUrl,
    ProjectNumber,
}

impl GoogleChatAudienceType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "app-url" | "app_url" | "app" => Some(Self::AppUrl),
            "project-number" | "project_number" | "project" => Some(Self::ProjectNumber),
            _ => None,
        }
    }
}

/// Configuration settings for the Google Chat plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatSettings {
    pub service_account: Option<String>,
    pub service_account_file: Option<String>,
    pub audience_type: GoogleChatAudienceType,
    pub audience: String,
    pub webhook_path: String,
    pub spaces: Vec<String>,
    pub require_mention: bool,
    pub enabled: bool,
    pub bot_user: Option<String>,
}

impl Default for GoogleChatSettings {
    fn default() -> Self {
        Self {
            service_account: None,
            service_account_file: None,
            audience_type: GoogleChatAudienceType::AppUrl,
            audience: String::new(),
            webhook_path: "/googlechat".to_string(),
            spaces: Vec::new(),
            require_mention: true,
            enabled: true,
            bot_user: None,
        }
    }
}

/// Google Chat space information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatSpace {
    pub name: String,
    pub display_name: Option<String>,
    pub space_type: String,
    pub single_user_bot_dm: bool,
    pub threaded: bool,
}

/// Google Chat user information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatUser {
    pub name: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub user_type: Option<String>,
    pub domain_id: Option<String>,
    pub is_anonymous: bool,
}

/// Google Chat thread information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatThread {
    pub name: String,
    pub thread_key: Option<String>,
}

/// Google Chat attachment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatAttachment {
    pub name: Option<String>,
    pub content_name: Option<String>,
    pub content_type: Option<String>,
    pub thumbnail_uri: Option<String>,
    pub download_uri: Option<String>,
    pub resource_name: Option<String>,
    pub attachment_upload_token: Option<String>,
}

/// Google Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatMessage {
    pub name: String,
    pub text: Option<String>,
    pub argument_text: Option<String>,
    pub sender: GoogleChatUser,
    pub create_time: String,
    pub thread: Option<GoogleChatThread>,
    pub space: GoogleChatSpace,
    pub attachments: Vec<GoogleChatAttachment>,
}

/// Google Chat webhook event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub event_time: Option<String>,
    pub space: Option<GoogleChatSpace>,
    pub user: Option<GoogleChatUser>,
    pub message: Option<GoogleChatMessage>,
}

/// Google Chat reaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatReaction {
    pub name: Option<String>,
    pub user: Option<GoogleChatUser>,
    pub emoji: Option<String>,
}

/// Options for sending a message
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GoogleChatMessageSendOptions {
    pub space: Option<String>,
    pub thread: Option<String>,
    pub text: Option<String>,
    pub attachments: Vec<AttachmentRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentRef {
    pub attachment_upload_token: String,
    pub content_name: Option<String>,
}

/// Result from sending a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleChatSendResult {
    pub success: bool,
    pub message_name: Option<String>,
    pub space: Option<String>,
    pub error: Option<String>,
}

impl GoogleChatSendResult {
    pub fn ok(message_name: String, space: String) -> Self {
        Self {
            success: true,
            message_name: Some(message_name),
            space: Some(space),
            error: None,
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            success: false,
            message_name: None,
            space: None,
            error: Some(error.into()),
        }
    }
}

/// Google Chat plugin errors
#[derive(Error, Debug)]
pub enum GoogleChatError {
    #[error("Google Chat service not initialized")]
    NotInitialized,

    #[error("Google Chat client not connected")]
    NotConnected,

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

    #[error("Authentication error: {message}")]
    Authentication { message: String },

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl GoogleChatError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: None,
        }
    }

    pub fn config_with_setting(message: impl Into<String>, setting: impl Into<String>) -> Self {
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

    pub fn auth(message: impl Into<String>) -> Self {
        Self::Authentication {
            message: message.into(),
        }
    }
}

// Utility functions

lazy_static::lazy_static! {
    static ref SPACE_NAME_REGEX: Regex = Regex::new(r"^spaces/[A-Za-z0-9_-]+$").unwrap();
    static ref USER_NAME_REGEX: Regex = Regex::new(r"^users/[A-Za-z0-9_-]+$").unwrap();
    static ref RESOURCE_ID_REGEX: Regex = Regex::new(r"^[A-Za-z0-9_-]+$").unwrap();
}

/// Check if a string is a valid Google Chat space name
pub fn is_valid_google_chat_space_name(name: &str) -> bool {
    SPACE_NAME_REGEX.is_match(name)
}

/// Check if a string is a valid Google Chat user name
pub fn is_valid_google_chat_user_name(name: &str) -> bool {
    USER_NAME_REGEX.is_match(name)
}

/// Normalize a Google Chat space target
pub fn normalize_space_target(target: &str) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("spaces/") {
        return Some(trimmed.to_string());
    }
    if RESOURCE_ID_REGEX.is_match(trimmed) {
        return Some(format!("spaces/{}", trimmed));
    }
    None
}

/// Normalize a Google Chat user target
pub fn normalize_user_target(target: &str) -> Option<String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("users/") {
        return Some(trimmed.to_string());
    }
    if RESOURCE_ID_REGEX.is_match(trimmed) {
        return Some(format!("users/{}", trimmed));
    }
    None
}

/// Extract the ID from a Google Chat resource name
pub fn extract_resource_id(resource_name: &str) -> &str {
    resource_name.split('/').last().unwrap_or(resource_name)
}

/// Get display name for a user
pub fn get_user_display_name(user: &GoogleChatUser) -> String {
    user.display_name
        .clone()
        .unwrap_or_else(|| extract_resource_id(&user.name).to_string())
}

/// Get display name for a space
pub fn get_space_display_name(space: &GoogleChatSpace) -> String {
    space
        .display_name
        .clone()
        .unwrap_or_else(|| extract_resource_id(&space.name).to_string())
}

/// Check if a space is a DM
pub fn is_direct_message(space: &GoogleChatSpace) -> bool {
    space.space_type == "DM" || space.single_user_bot_dm
}

/// Split long text into chunks for Google Chat
pub fn split_message_for_google_chat(
    text: &str,
    max_length: usize,
) -> Vec<String> {
    if text.len() <= max_length {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_length {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a good break point
        let mut break_point = max_length;
        if let Some(newline_idx) = remaining[..max_length].rfind('\n') {
            if newline_idx > max_length / 2 {
                break_point = newline_idx + 1;
            }
        } else if let Some(space_idx) = remaining[..max_length].rfind(' ') {
            if space_idx > max_length / 2 {
                break_point = space_idx + 1;
            }
        }

        chunks.push(remaining[..break_point].trim_end().to_string());
        remaining = remaining[break_point..].trim_start();
    }

    chunks
}
