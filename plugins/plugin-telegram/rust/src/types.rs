use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
/// Event types emitted by the Telegram plugin.
pub enum TelegramEventType {
    /// The bot joined a Telegram "world" (chat) context.
    WorldJoined,
    /// The bot connected successfully and is ready to receive updates.
    WorldConnected,
    /// The bot left a Telegram "world" (chat) context.
    WorldLeft,
    /// A user joined a chat.
    EntityJoined,
    /// A user left a chat.
    EntityLeft,
    /// A user's membership or profile was updated.
    EntityUpdated,
    /// A message was received.
    MessageReceived,
    /// A message was sent by the bot.
    MessageSent,
    /// A reaction was received.
    ReactionReceived,
    /// An interaction (e.g. callback query) was received.
    InteractionReceived,
    /// The `/start` command was invoked.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
/// Telegram chat/channel type.
pub enum TelegramChannelType {
    /// One-on-one private chat.
    Private,
    /// Group chat.
    Group,
    /// Supergroup chat.
    Supergroup,
    /// Broadcast channel.
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
    /// Returns a human-friendly display name for the user.
    pub fn display_name(&self) -> String {
        match (&self.first_name, &self.last_name) {
            (Some(first), Some(last)) => format!("{} {}", first, last),
            (Some(first), None) => first.clone(),
            (None, Some(last)) => last.clone(),
            (None, None) => self.username.clone().unwrap_or_else(|| self.id.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Telegram chat information.
pub struct TelegramChat {
    /// Chat identifier.
    pub id: i64,
    /// Chat kind (private, group, supergroup, channel).
    #[serde(rename = "type")]
    pub chat_type: TelegramChannelType,
    /// Chat title (for groups/channels).
    pub title: Option<String>,
    /// Chat username (without `@`), when present.
    pub username: Option<String>,
    /// First name (for private chats).
    pub first_name: Option<String>,
    /// Whether this chat supports forum topics.
    pub is_forum: bool,
}

impl TelegramChat {
    /// Returns a human-friendly display name for the chat.
    pub fn display_name(&self) -> String {
        self.title
            .clone()
            .or_else(|| self.first_name.clone())
            .or_else(|| self.username.clone())
            .unwrap_or_else(|| self.id.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload for a received or sent message event.
pub struct TelegramMessagePayload {
    /// Message identifier.
    pub message_id: i64,
    /// Chat where the message occurred.
    pub chat: TelegramChat,
    /// Message sender, if available.
    pub from_user: Option<TelegramUser>,
    /// Message text (if the message has text content).
    pub text: Option<String>,
    /// Message timestamp (seconds since epoch).
    pub date: i64,
    /// Optional forum topic/thread identifier.
    pub thread_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload for a reaction event.
pub struct TelegramReactionPayload {
    /// Message identifier the reaction applies to.
    pub message_id: i64,
    /// Chat where the reaction occurred.
    pub chat: TelegramChat,
    /// User who reacted, if available.
    pub from_user: Option<TelegramUser>,
    /// Reaction identifier (e.g. emoji).
    pub reaction: String,
    /// Reaction timestamp (seconds since epoch).
    pub date: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload describing the bot's current world/chat context.
pub struct TelegramWorldPayload {
    /// The chat representing the "world".
    pub chat: TelegramChat,
    /// Bot username (without `@`), when available.
    pub bot_username: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
/// Membership/action performed by an entity (user) in a chat.
pub enum EntityAction {
    /// Entity joined the chat.
    Joined,
    /// Entity left the chat.
    Left,
    /// Entity information was updated.
    Updated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload describing a user-related event in a chat.
pub struct TelegramEntityPayload {
    /// The user entity.
    pub user: TelegramUser,
    /// The chat where the event occurred.
    pub chat: TelegramChat,
    /// The action performed.
    pub action: EntityAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload for Telegram callback queries / button interactions.
pub struct TelegramCallbackPayload {
    /// Callback query ID.
    pub id: String,
    /// The user who triggered the callback.
    pub from_user: TelegramUser,
    /// Optional chat context (may be absent for some callback types).
    pub chat: Option<TelegramChat>,
    /// Optional message ID the callback relates to.
    pub message_id: Option<i64>,
    /// Optional callback data payload.
    pub data: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
/// Settings used by the Telegram plugin runtime.
pub struct TelegramSettings {
    /// If non-empty, only allow these chat IDs.
    pub allowed_chat_ids: Vec<i64>,
    /// Whether to ignore messages from bots.
    pub should_ignore_bot_messages: bool,
    /// Whether to respond only to explicit mentions.
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
