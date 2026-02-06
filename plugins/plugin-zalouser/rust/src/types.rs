//! Type definitions for the Zalo User plugin.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Event types emitted by the Zalo User plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ZaloUserEventType {
    /// Joined a Zalo chat "world".
    WorldJoined,
    /// Connected successfully.
    WorldConnected,
    /// Left a Zalo chat "world".
    WorldLeft,
    /// An entity (user) joined a chat.
    EntityJoined,
    /// An entity left a chat.
    EntityLeft,
    /// An entity's info was updated.
    EntityUpdated,
    /// A message was received.
    MessageReceived,
    /// A message was sent.
    MessageSent,
    /// A reaction was received.
    ReactionReceived,
    /// A reaction was sent.
    ReactionSent,
    /// QR code is ready for scanning.
    QrCodeReady,
    /// Login successful.
    LoginSuccess,
    /// Login failed.
    LoginFailed,
    /// Client started.
    ClientStarted,
    /// Client stopped.
    ClientStopped,
}

impl fmt::Display for ZaloUserEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::WorldJoined => "ZALOUSER_WORLD_JOINED",
            Self::WorldConnected => "ZALOUSER_WORLD_CONNECTED",
            Self::WorldLeft => "ZALOUSER_WORLD_LEFT",
            Self::EntityJoined => "ZALOUSER_ENTITY_JOINED",
            Self::EntityLeft => "ZALOUSER_ENTITY_LEFT",
            Self::EntityUpdated => "ZALOUSER_ENTITY_UPDATED",
            Self::MessageReceived => "ZALOUSER_MESSAGE_RECEIVED",
            Self::MessageSent => "ZALOUSER_MESSAGE_SENT",
            Self::ReactionReceived => "ZALOUSER_REACTION_RECEIVED",
            Self::ReactionSent => "ZALOUSER_REACTION_SENT",
            Self::QrCodeReady => "ZALOUSER_QR_CODE_READY",
            Self::LoginSuccess => "ZALOUSER_LOGIN_SUCCESS",
            Self::LoginFailed => "ZALOUSER_LOGIN_FAILED",
            Self::ClientStarted => "ZALOUSER_CLIENT_STARTED",
            Self::ClientStopped => "ZALOUSER_CLIENT_STOPPED",
        };
        write!(f, "{}", s)
    }
}

/// Zalo chat type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ZaloUserChatType {
    /// One-on-one private chat.
    Private,
    /// Group chat.
    Group,
}

impl fmt::Display for ZaloUserChatType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Private => "private",
            Self::Group => "group",
        };
        write!(f, "{}", s)
    }
}

/// Zalo user information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloUser {
    /// User ID.
    pub id: String,
    /// Display name.
    pub display_name: String,
    /// Username (phone number or alias).
    pub username: Option<String>,
    /// Avatar URL.
    pub avatar: Option<String>,
    /// Whether this is the authenticated user.
    #[serde(default)]
    pub is_self: bool,
}

impl ZaloUser {
    /// Returns a human-friendly display name.
    pub fn name(&self) -> &str {
        &self.display_name
    }
}

/// Zalo chat/conversation information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloChat {
    /// Thread/conversation ID.
    pub thread_id: String,
    /// Chat type.
    #[serde(rename = "type")]
    pub chat_type: ZaloUserChatType,
    /// Chat name.
    pub name: Option<String>,
    /// Avatar URL.
    pub avatar: Option<String>,
    /// Number of members (for groups).
    pub member_count: Option<u32>,
    /// Whether this is a group chat.
    #[serde(default)]
    pub is_group: bool,
}

impl ZaloChat {
    /// Returns a human-friendly display name.
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .unwrap_or_else(|| self.thread_id.clone())
    }
}

/// Zalo friend entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloFriend {
    /// User ID.
    #[serde(rename = "userId")]
    pub user_id: String,
    /// Display name.
    #[serde(rename = "displayName")]
    pub display_name: String,
    /// Avatar URL.
    pub avatar: Option<String>,
    /// Phone number.
    pub phone_number: Option<String>,
}

/// Zalo group entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloGroup {
    /// Group ID.
    #[serde(rename = "groupId")]
    pub group_id: String,
    /// Group name.
    pub name: String,
    /// Member count.
    #[serde(rename = "memberCount")]
    pub member_count: Option<u32>,
    /// Avatar URL.
    pub avatar: Option<String>,
}

/// Zalo message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMessage {
    /// Message ID.
    #[serde(rename = "msgId")]
    pub msg_id: Option<String>,
    /// CLI message ID.
    #[serde(rename = "cliMsgId")]
    pub cli_msg_id: Option<String>,
    /// Thread/conversation ID.
    #[serde(rename = "threadId")]
    pub thread_id: String,
    /// Message type code.
    #[serde(rename = "type")]
    pub message_type: i32,
    /// Message content.
    pub content: String,
    /// Timestamp in milliseconds.
    pub timestamp: i64,
    /// Message metadata.
    pub metadata: Option<ZaloMessageMetadata>,
}

/// Zalo message metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMessageMetadata {
    /// Whether this is a group message.
    #[serde(rename = "isGroup", default)]
    pub is_group: bool,
    /// Thread/chat name.
    #[serde(rename = "threadName")]
    pub thread_name: Option<String>,
    /// Sender name.
    #[serde(rename = "senderName")]
    pub sender_name: Option<String>,
    /// Sender ID.
    #[serde(rename = "fromId")]
    pub sender_id: Option<String>,
}

/// Zalo message payload for events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMessagePayload {
    /// Original message.
    pub message: ZaloMessage,
    /// Chat info.
    pub chat: ZaloChat,
    /// Sender info.
    pub sender: Option<ZaloUser>,
}

/// Zalo world/chat payload for events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloWorldPayload {
    /// Chat info.
    pub chat: ZaloChat,
    /// Current authenticated user.
    pub current_user: Option<ZaloUser>,
}

/// Authenticated user info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloUserInfo {
    /// User ID.
    #[serde(rename = "userId")]
    pub user_id: String,
    /// Display name.
    #[serde(rename = "displayName")]
    pub display_name: String,
    /// Avatar URL.
    pub avatar: Option<String>,
    /// Phone number.
    pub phone_number: Option<String>,
}

/// Probe result for health checks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloUserProbe {
    /// Whether the probe was successful.
    pub ok: bool,
    /// User info if authenticated.
    pub user: Option<ZaloUser>,
    /// Error message if failed.
    pub error: Option<String>,
    /// Latency in milliseconds.
    pub latency_ms: u64,
}

/// Client status payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloUserClientStatus {
    /// Profile name.
    pub profile: Option<String>,
    /// User info.
    pub user: Option<ZaloUser>,
    /// Whether running.
    pub running: bool,
    /// Timestamp.
    pub timestamp: i64,
}

/// QR code ready payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloUserQrCodePayload {
    /// Base64 QR code data URL.
    pub qr_data_url: Option<String>,
    /// Message/instructions.
    pub message: String,
    /// Profile being authenticated.
    pub profile: Option<String>,
}

/// Send message parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageParams {
    /// Thread ID to send to.
    pub thread_id: String,
    /// Message text.
    pub text: String,
    /// Whether this is a group message.
    #[serde(default)]
    pub is_group: bool,
    /// Profile to use.
    pub profile: Option<String>,
}

/// Send message result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    /// Whether successful.
    pub success: bool,
    /// Thread ID.
    pub thread_id: String,
    /// Message ID if successful.
    pub message_id: Option<String>,
    /// Error message if failed.
    pub error: Option<String>,
}

/// Send media parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMediaParams {
    /// Thread ID to send to.
    pub thread_id: String,
    /// Media URL.
    pub media_url: String,
    /// Optional caption.
    pub caption: Option<String>,
    /// Whether this is a group message.
    #[serde(default)]
    pub is_group: bool,
    /// Profile to use.
    pub profile: Option<String>,
}

/// Zalo profile configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloUserProfile {
    /// Profile name.
    pub name: String,
    /// Display label.
    pub label: Option<String>,
    /// Whether default.
    #[serde(rename = "isDefault", default)]
    pub is_default: bool,
    /// Cookie path.
    pub cookie_path: Option<String>,
    /// IMEI.
    pub imei: Option<String>,
    /// User agent.
    pub user_agent: Option<String>,
}

/// Zalo User settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ZaloUserSettings {
    /// Cookie path.
    pub cookie_path: Option<String>,
    /// IMEI.
    pub imei: Option<String>,
    /// User agent.
    pub user_agent: Option<String>,
    /// Profiles JSON.
    pub profiles_json: Option<String>,
    /// Whether enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Default profile.
    #[serde(default = "default_profile")]
    pub default_profile: String,
    /// Listen timeout.
    #[serde(default = "default_timeout")]
    pub listen_timeout: u64,
    /// Allowed thread IDs.
    #[serde(default)]
    pub allowed_threads: Vec<String>,
    /// DM policy.
    #[serde(default = "default_dm_policy")]
    pub dm_policy: String,
    /// Group policy.
    #[serde(default = "default_group_policy")]
    pub group_policy: String,
}

fn default_true() -> bool {
    true
}

fn default_profile() -> String {
    "default".to_string()
}

fn default_timeout() -> u64 {
    30000
}

fn default_dm_policy() -> String {
    "pairing".to_string()
}

fn default_group_policy() -> String {
    "disabled".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            ZaloUserEventType::MessageReceived.to_string(),
            "ZALOUSER_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_chat_type_display() {
        assert_eq!(ZaloUserChatType::Private.to_string(), "private");
        assert_eq!(ZaloUserChatType::Group.to_string(), "group");
    }

    #[test]
    fn test_user_name() {
        let user = ZaloUser {
            id: "123".to_string(),
            display_name: "Test User".to_string(),
            username: Some("testuser".to_string()),
            avatar: None,
            is_self: false,
        };
        assert_eq!(user.name(), "Test User");
    }

    #[test]
    fn test_chat_display_name() {
        let chat = ZaloChat {
            thread_id: "123".to_string(),
            chat_type: ZaloUserChatType::Group,
            name: Some("Test Group".to_string()),
            avatar: None,
            member_count: Some(5),
            is_group: true,
        };
        assert_eq!(chat.display_name(), "Test Group");
    }
}
