//! Serializable types used for events and payloads.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Event types emitted by the Zalo plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ZaloEventType {
    /// Bot started successfully.
    BotStarted,
    /// Bot stopped.
    BotStopped,
    /// A message was received.
    MessageReceived,
    /// A message was sent.
    MessageSent,
    /// Webhook was registered.
    WebhookRegistered,
    /// User followed the OA.
    UserFollowed,
    /// User unfollowed the OA.
    UserUnfollowed,
    /// Access token was refreshed.
    TokenRefreshed,
}

impl fmt::Display for ZaloEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::BotStarted => "ZALO_BOT_STARTED",
            Self::BotStopped => "ZALO_BOT_STOPPED",
            Self::MessageReceived => "ZALO_MESSAGE_RECEIVED",
            Self::MessageSent => "ZALO_MESSAGE_SENT",
            Self::WebhookRegistered => "ZALO_WEBHOOK_REGISTERED",
            Self::UserFollowed => "ZALO_USER_FOLLOWED",
            Self::UserUnfollowed => "ZALO_USER_UNFOLLOWED",
            Self::TokenRefreshed => "ZALO_TOKEN_REFRESHED",
        };
        write!(f, "{}", s)
    }
}

/// Zalo user information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloUser {
    /// User ID.
    pub id: String,
    /// User display name.
    pub name: Option<String>,
    /// User avatar URL.
    pub avatar: Option<String>,
}

impl ZaloUser {
    /// Returns a display name for the user.
    pub fn display_name(&self) -> String {
        self.name.clone().unwrap_or_else(|| self.id.clone())
    }
}

/// Zalo chat information (always DM for OA).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloChat {
    /// Chat/user ID.
    pub id: String,
    /// Chat type (always "PRIVATE" for OA).
    #[serde(rename = "type")]
    pub chat_type: String,
}

impl Default for ZaloChat {
    fn default() -> Self {
        Self {
            id: String::new(),
            chat_type: "PRIVATE".to_string(),
        }
    }
}

/// Zalo message structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMessage {
    /// Message ID.
    pub message_id: String,
    /// Sender information.
    pub from: ZaloUser,
    /// Chat information.
    pub chat: ZaloChat,
    /// Message timestamp (Unix seconds).
    pub date: i64,
    /// Text content.
    pub text: Option<String>,
    /// Image URL.
    pub photo: Option<String>,
    /// Image caption.
    pub caption: Option<String>,
    /// Sticker ID.
    pub sticker: Option<String>,
}

/// Zalo OA information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloOAInfo {
    /// OA ID.
    pub oa_id: String,
    /// OA name.
    pub name: String,
    /// OA description.
    pub description: Option<String>,
    /// OA avatar URL.
    pub avatar: Option<String>,
    /// OA cover URL.
    pub cover: Option<String>,
}

/// Zalo API response wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloApiResponse<T> {
    /// Error code (0 for success).
    pub error: i32,
    /// Error message.
    pub message: String,
    /// Response data.
    pub data: Option<T>,
}

/// Parameters for sending a text message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloSendMessageParams {
    /// Recipient user ID.
    pub user_id: String,
    /// Message text.
    pub text: String,
}

/// Parameters for sending an image message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloSendImageParams {
    /// Recipient user ID.
    pub user_id: String,
    /// Image URL.
    pub image_url: String,
    /// Optional caption.
    pub caption: Option<String>,
}

/// Result of probing the Zalo OA connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloBotProbe {
    /// Whether the probe was successful.
    pub ok: bool,
    /// OA info if successful.
    pub oa: Option<ZaloOAInfo>,
    /// Error message if failed.
    pub error: Option<String>,
    /// Latency in milliseconds.
    pub latency_ms: u64,
}

/// Bot status payload for start/stop events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloBotStatusPayload {
    /// OA ID.
    pub oa_id: Option<String>,
    /// OA name.
    pub oa_name: Option<String>,
    /// Update mode (polling or webhook).
    pub update_mode: String,
    /// Timestamp in milliseconds.
    pub timestamp: i64,
}

/// Webhook registration payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloWebhookPayload {
    /// Full webhook URL.
    pub url: String,
    /// Webhook path.
    pub path: String,
    /// Webhook port.
    pub port: Option<u16>,
    /// Timestamp in milliseconds.
    pub timestamp: i64,
}

/// Message payload for events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMessagePayload {
    /// Message ID.
    pub message_id: String,
    /// Chat information.
    pub chat: ZaloChat,
    /// Sender information.
    pub from_user: Option<ZaloUser>,
    /// Message text.
    pub text: Option<String>,
    /// Message timestamp.
    pub date: i64,
}

/// User follow/unfollow payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloFollowPayload {
    /// User ID.
    pub user_id: String,
    /// Action type.
    pub action: String,
    /// Timestamp.
    pub timestamp: i64,
}

/// Zalo settings.
#[derive(Debug, Clone, Default)]
pub struct ZaloSettings {
    /// App ID.
    pub app_id: String,
    /// Secret key.
    pub secret_key: String,
    /// Access token.
    pub access_token: String,
    /// Refresh token.
    pub refresh_token: Option<String>,
    /// Update mode.
    pub update_mode: String,
    /// Webhook URL.
    pub webhook_url: Option<String>,
    /// Webhook path.
    pub webhook_path: String,
    /// Webhook port.
    pub webhook_port: u16,
    /// Whether enabled.
    pub enabled: bool,
    /// Proxy URL.
    pub proxy_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            ZaloEventType::MessageReceived.to_string(),
            "ZALO_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_user_display_name() {
        let user = ZaloUser {
            id: "12345".to_string(),
            name: Some("Test User".to_string()),
            avatar: None,
        };
        assert_eq!(user.display_name(), "Test User");

        let user_no_name = ZaloUser {
            id: "12345".to_string(),
            name: None,
            avatar: None,
        };
        assert_eq!(user_no_name.display_name(), "12345");
    }
}
