use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
/// Event types emitted by the Feishu plugin.
pub enum FeishuEventType {
    /// The bot joined a Feishu "world" (chat) context.
    WorldJoined,
    /// The bot connected successfully and is ready to receive updates.
    WorldConnected,
    /// The bot left a Feishu "world" (chat) context.
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
    /// An interaction (e.g. card action) was received.
    InteractionReceived,
    /// A slash command was invoked.
    SlashStart,
}

impl fmt::Display for FeishuEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::WorldJoined => "FEISHU_WORLD_JOINED",
            Self::WorldConnected => "FEISHU_WORLD_CONNECTED",
            Self::WorldLeft => "FEISHU_WORLD_LEFT",
            Self::EntityJoined => "FEISHU_ENTITY_JOINED",
            Self::EntityLeft => "FEISHU_ENTITY_LEFT",
            Self::EntityUpdated => "FEISHU_ENTITY_UPDATED",
            Self::MessageReceived => "FEISHU_MESSAGE_RECEIVED",
            Self::MessageSent => "FEISHU_MESSAGE_SENT",
            Self::ReactionReceived => "FEISHU_REACTION_RECEIVED",
            Self::InteractionReceived => "FEISHU_INTERACTION_RECEIVED",
            Self::SlashStart => "FEISHU_SLASH_START",
        };
        write!(f, "{}", s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
/// Feishu chat/channel type.
pub enum FeishuChatType {
    /// One-on-one private chat.
    P2p,
    /// Group chat.
    Group,
}

impl fmt::Display for FeishuChatType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::P2p => "p2p",
            Self::Group => "group",
        };
        write!(f, "{}", s)
    }
}

/// Feishu content extension
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FeishuContent {
    /// Text content
    pub text: Option<String>,
    /// Interactive card content (JSON string)
    pub card: Option<serde_json::Value>,
    /// Image key for image messages
    pub image_key: Option<String>,
    /// File key for file messages
    pub file_key: Option<String>,
}

/// Feishu user information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuUser {
    /// Open ID (user identifier)
    pub open_id: String,
    /// Union ID (cross-app identifier)
    pub union_id: Option<String>,
    /// User ID (tenant-level identifier)
    pub user_id: Option<String>,
    /// User's display name
    pub name: Option<String>,
    /// User's avatar URL
    pub avatar_url: Option<String>,
    /// Whether the user is a bot
    pub is_bot: bool,
}

impl FeishuUser {
    /// Returns a human-friendly display name for the user.
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .unwrap_or_else(|| self.open_id.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Feishu chat information.
pub struct FeishuChat {
    /// Chat identifier.
    pub chat_id: String,
    /// Chat kind (p2p or group).
    #[serde(rename = "type")]
    pub chat_type: FeishuChatType,
    /// Chat name/title.
    pub name: Option<String>,
    /// Chat owner's open ID.
    pub owner_open_id: Option<String>,
    /// Chat description.
    pub description: Option<String>,
    /// Tenant key.
    pub tenant_key: Option<String>,
}

impl FeishuChat {
    /// Returns a human-friendly display name for the chat.
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .unwrap_or_else(|| self.chat_id.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Feishu message mention information.
pub struct FeishuMention {
    /// Mention key in the message.
    pub key: String,
    /// Mentioned user's ID.
    pub id: String,
    /// ID type.
    pub id_type: String,
    /// Mentioned user's name.
    pub name: String,
    /// Tenant key.
    pub tenant_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload for a received or sent message event.
pub struct FeishuMessagePayload {
    /// Message identifier.
    pub message_id: String,
    /// Root message ID (for threads).
    pub root_id: Option<String>,
    /// Parent message ID (for replies).
    pub parent_id: Option<String>,
    /// Message type.
    pub msg_type: String,
    /// Message content (JSON string).
    pub content: String,
    /// Create time (Unix timestamp in milliseconds).
    pub create_time: String,
    /// Chat where the message occurred.
    pub chat: FeishuChat,
    /// Message sender, if available.
    pub sender: Option<FeishuUser>,
    /// Mentions in the message.
    pub mentions: Option<Vec<FeishuMention>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload for a reaction event.
pub struct FeishuReactionPayload {
    /// Message identifier the reaction applies to.
    pub message_id: String,
    /// Chat where the reaction occurred.
    pub chat: FeishuChat,
    /// User who reacted, if available.
    pub user: Option<FeishuUser>,
    /// Reaction type/emoji.
    pub reaction_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload describing the bot's current world/chat context.
pub struct FeishuWorldPayload {
    /// The chat representing the "world".
    pub chat: FeishuChat,
    /// Bot's open ID, when available.
    pub bot_open_id: Option<String>,
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
pub struct FeishuEntityPayload {
    /// The user entity.
    pub user: FeishuUser,
    /// The chat where the event occurred.
    pub chat: FeishuChat,
    /// The action performed.
    pub action: EntityAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Payload for Feishu card interactions.
pub struct FeishuInteractionPayload {
    /// Interaction type.
    pub interaction_type: String,
    /// Action tag.
    pub action_tag: String,
    /// Action value (key-value pairs).
    pub action_value: Option<serde_json::Value>,
    /// The user who triggered the interaction.
    pub user: FeishuUser,
    /// Optional chat context.
    pub chat: Option<FeishuChat>,
    /// Token for responding to the interaction.
    pub token: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
/// Settings used by the Feishu plugin runtime.
pub struct FeishuSettings {
    /// If non-empty, only allow these chat IDs.
    pub allowed_chat_ids: Vec<String>,
    /// Whether to ignore messages from bots.
    pub should_ignore_bot_messages: bool,
    /// Whether to respond only to explicit mentions.
    pub should_respond_only_to_mentions: bool,
}

/// Feishu tenant access token response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantAccessToken {
    /// Access token value.
    pub tenant_access_token: String,
    /// Token expiration in seconds.
    pub expire: i64,
}

/// Feishu API response wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuApiResponse<T> {
    /// Response code (0 = success).
    pub code: i32,
    /// Response message.
    pub msg: String,
    /// Response data.
    pub data: Option<T>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            FeishuEventType::MessageReceived.to_string(),
            "FEISHU_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_chat_type_display() {
        assert_eq!(FeishuChatType::P2p.to_string(), "p2p");
        assert_eq!(FeishuChatType::Group.to_string(), "group");
    }

    #[test]
    fn test_user_display_name() {
        let user = FeishuUser {
            open_id: "ou_test123".to_string(),
            union_id: Some("on_test456".to_string()),
            user_id: None,
            name: Some("Test User".to_string()),
            avatar_url: None,
            is_bot: false,
        };
        assert_eq!(user.display_name(), "Test User");

        let user_no_name = FeishuUser {
            open_id: "ou_test123".to_string(),
            union_id: None,
            user_id: None,
            name: None,
            avatar_url: None,
            is_bot: false,
        };
        assert_eq!(user_no_name.display_name(), "ou_test123");
    }

    #[test]
    fn test_chat_display_name() {
        let chat = FeishuChat {
            chat_id: "oc_test123".to_string(),
            chat_type: FeishuChatType::Group,
            name: Some("Test Group".to_string()),
            owner_open_id: None,
            description: None,
            tenant_key: None,
        };
        assert_eq!(chat.display_name(), "Test Group");
    }
}
