//! Type definitions for the Telegram plugin
//!
//! Strong types with validation - no unknown or any types.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Telegram event types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TelegramEventType {
    /// World/chat joined
    WorldJoined,
    /// Bot connected to Telegram
    WorldConnected,
    /// World/chat left
    WorldLeft,
    /// Entity (user) joined
    EntityJoined,
    /// Entity (user) left
    EntityLeft,
    /// Entity updated
    EntityUpdated,
    /// Message received
    MessageReceived,
    /// Message sent by bot
    MessageSent,
    /// Reaction received
    ReactionReceived,
    /// Interaction (callback query) received
    InteractionReceived,
    /// /start command
    SlashStart,
}

impl fmt::Display for TelegramEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::WorldJoined => "TELEGRAM_WORLD_JOINED",
            Self::WorldConnected => "TELEGRAM_WORLD_CONNECTED",
            Self::WorldLeft => "TELEGRAM_WORLD_LEFT",
            Self::EntityJoined => "TELEGRAM_ENTITY_JOINED",
            Self::EntityLeft => "TELEGRAM_ENTITY_LEFT",
            Self::EntityUpdated => "TELEGRAM_ENTITY_UPDATED",
            Self::MessageReceived => "TELEGRAM_MESSAGE_RECEIVED",
            Self::MessageSent => "TELEGRAM_MESSAGE_SENT",
            Self::ReactionReceived => "TELEGRAM_REACTION_RECEIVED",
            Self::InteractionReceived => "TELEGRAM_INTERACTION_RECEIVED",
            Self::SlashStart => "TELEGRAM_SLASH_START",
        };
        write!(f, "{}", s)
    }
}

/// Telegram channel types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelegramChannelType {
    /// Private chat (DM)
    Private,
    /// Group chat
    Group,
    /// Supergroup chat
    Supergroup,
    /// Channel
    Channel,
}

impl fmt::Display for TelegramChannelType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Private => "private",
            Self::Group => "group",
            Self::Supergroup => "supergroup",
            Self::Channel => "channel",
        };
        write!(f, "{}", s)
    }
}

/// Button kind for inline keyboards
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonKind {
    /// Login button
    Login,
    /// URL button
    Url,
}

/// Telegram button
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Button {
    /// Button kind
    pub kind: ButtonKind,
    /// Button text
    pub text: String,
    /// Button URL
    pub url: String,
}

/// Telegram content extension
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelegramContent {
    /// Text content
    pub text: Option<String>,
    /// Buttons
    pub buttons: Vec<Button>,
}

/// Telegram user information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramUser {
    /// User ID
    pub id: i64,
    /// Username (without @)
    pub username: Option<String>,
    /// First name
    pub first_name: Option<String>,
    /// Last name
    pub last_name: Option<String>,
    /// Whether user is a bot
    pub is_bot: bool,
}

impl TelegramUser {
    /// Get display name (first + last name, or username, or ID)
    pub fn display_name(&self) -> String {
        match (&self.first_name, &self.last_name) {
            (Some(first), Some(last)) => format!("{} {}", first, last),
            (Some(first), None) => first.clone(),
            (None, Some(last)) => last.clone(),
            (None, None) => self
                .username
                .clone()
                .unwrap_or_else(|| self.id.to_string()),
        }
    }
}

/// Telegram chat information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramChat {
    /// Chat ID
    pub id: i64,
    /// Chat type
    #[serde(rename = "type")]
    pub chat_type: TelegramChannelType,
    /// Chat title (for groups/channels)
    pub title: Option<String>,
    /// Chat username
    pub username: Option<String>,
    /// First name (for private chats)
    pub first_name: Option<String>,
    /// Whether chat is a forum
    pub is_forum: bool,
}

impl TelegramChat {
    /// Get display name
    pub fn display_name(&self) -> String {
        self.title
            .clone()
            .or_else(|| self.first_name.clone())
            .or_else(|| self.username.clone())
            .unwrap_or_else(|| self.id.to_string())
    }
}

/// Telegram message payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramMessagePayload {
    /// Message ID
    pub message_id: i64,
    /// Chat information
    pub chat: TelegramChat,
    /// User who sent the message
    pub from_user: Option<TelegramUser>,
    /// Message text
    pub text: Option<String>,
    /// Unix timestamp
    pub date: i64,
    /// Thread ID (for forum topics)
    pub thread_id: Option<i64>,
}

/// Telegram reaction payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramReactionPayload {
    /// Message ID
    pub message_id: i64,
    /// Chat information
    pub chat: TelegramChat,
    /// User who reacted
    pub from_user: Option<TelegramUser>,
    /// Reaction emoji
    pub reaction: String,
    /// Unix timestamp
    pub date: i64,
}

/// Telegram world (chat) payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramWorldPayload {
    /// Chat information
    pub chat: TelegramChat,
    /// Bot username
    pub bot_username: Option<String>,
}

/// Action type for entity events
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityAction {
    /// Entity joined
    Joined,
    /// Entity left
    Left,
    /// Entity updated
    Updated,
}

/// Telegram entity (user) payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramEntityPayload {
    /// User information
    pub user: TelegramUser,
    /// Chat information
    pub chat: TelegramChat,
    /// Action type
    pub action: EntityAction,
}

/// Callback query (button click) payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramCallbackPayload {
    /// Callback query ID
    pub id: String,
    /// User who clicked
    pub from_user: TelegramUser,
    /// Chat where button was clicked
    pub chat: Option<TelegramChat>,
    /// Message with the button
    pub message_id: Option<i64>,
    /// Callback data
    pub data: Option<String>,
}

/// Settings for a Telegram chat
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelegramSettings {
    /// Allowed chat IDs
    pub allowed_chat_ids: Vec<i64>,
    /// Whether to ignore bot messages
    pub should_ignore_bot_messages: bool,
    /// Whether to only respond when mentioned
    pub should_respond_only_to_mentions: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            TelegramEventType::MessageReceived.to_string(),
            "TELEGRAM_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_channel_type_display() {
        assert_eq!(TelegramChannelType::Private.to_string(), "private");
        assert_eq!(TelegramChannelType::Supergroup.to_string(), "supergroup");
    }

    #[test]
    fn test_user_display_name() {
        let user = TelegramUser {
            id: 12345,
            username: Some("testuser".to_string()),
            first_name: Some("Test".to_string()),
            last_name: Some("User".to_string()),
            is_bot: false,
        };
        assert_eq!(user.display_name(), "Test User");

        let user_no_last = TelegramUser {
            id: 12345,
            username: Some("testuser".to_string()),
            first_name: Some("Test".to_string()),
            last_name: None,
            is_bot: false,
        };
        assert_eq!(user_no_last.display_name(), "Test");

        let user_only_username = TelegramUser {
            id: 12345,
            username: Some("testuser".to_string()),
            first_name: None,
            last_name: None,
            is_bot: false,
        };
        assert_eq!(user_only_username.display_name(), "testuser");
    }

    #[test]
    fn test_chat_display_name() {
        let chat = TelegramChat {
            id: -12345,
            chat_type: TelegramChannelType::Group,
            title: Some("Test Group".to_string()),
            username: None,
            first_name: None,
            is_forum: false,
        };
        assert_eq!(chat.display_name(), "Test Group");
    }
}
