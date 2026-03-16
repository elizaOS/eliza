use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
/// Event types emitted by the Nextcloud Talk plugin.
pub enum NextcloudTalkEventType {
    /// The bot joined a Nextcloud Talk "world" (room) context.
    WorldJoined,
    /// The bot connected successfully and is ready to receive updates.
    WorldConnected,
    /// The bot left a Nextcloud Talk "world" (room) context.
    WorldLeft,
    /// A message was received.
    MessageReceived,
    /// A message was sent by the bot.
    MessageSent,
    /// A reaction was received.
    ReactionReceived,
    /// A reaction was sent.
    ReactionSent,
    /// A webhook was received.
    WebhookReceived,
}

impl fmt::Display for NextcloudTalkEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::WorldJoined => "NEXTCLOUD_TALK_WORLD_JOINED",
            Self::WorldConnected => "NEXTCLOUD_TALK_WORLD_CONNECTED",
            Self::WorldLeft => "NEXTCLOUD_TALK_WORLD_LEFT",
            Self::MessageReceived => "NEXTCLOUD_TALK_MESSAGE_RECEIVED",
            Self::MessageSent => "NEXTCLOUD_TALK_MESSAGE_SENT",
            Self::ReactionReceived => "NEXTCLOUD_TALK_REACTION_RECEIVED",
            Self::ReactionSent => "NEXTCLOUD_TALK_REACTION_SENT",
            Self::WebhookReceived => "NEXTCLOUD_TALK_WEBHOOK_RECEIVED",
        };
        write!(f, "{}", s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
/// Nextcloud Talk room type.
pub enum NextcloudTalkRoomType {
    /// One-to-one private chat.
    OneToOne,
    /// Group chat.
    Group,
    /// Public room.
    Public,
    /// Changelog room.
    Changelog,
}

impl fmt::Display for NextcloudTalkRoomType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::OneToOne => "one-to-one",
            Self::Group => "group",
            Self::Public => "public",
            Self::Changelog => "changelog",
        };
        write!(f, "{}", s)
    }
}

/// Actor in the activity (the message sender).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkActor {
    /// Actor type (usually "Person").
    #[serde(rename = "type")]
    pub actor_type: String,
    /// User ID in Nextcloud.
    pub id: String,
    /// Display name of the user.
    pub name: String,
}

/// The message object in the activity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkObject {
    /// Object type (usually "Note").
    #[serde(rename = "type")]
    pub object_type: String,
    /// Message ID.
    pub id: String,
    /// Message text (same as content for text/plain).
    pub name: String,
    /// Message content.
    pub content: String,
    /// Media type of the content.
    #[serde(rename = "mediaType")]
    pub media_type: String,
}

/// Target conversation/room.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkTarget {
    /// Target type (usually "Collection").
    #[serde(rename = "type")]
    pub target_type: String,
    /// Room token.
    pub id: String,
    /// Room display name.
    pub name: String,
}

/// Incoming webhook payload from Nextcloud Talk (Activity Streams 2.0 format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkWebhookPayload {
    /// Event type (Create, Update, Delete).
    #[serde(rename = "type")]
    pub event_type: String,
    /// Actor (message sender).
    pub actor: NextcloudTalkActor,
    /// Message object.
    pub object: NextcloudTalkObject,
    /// Target room.
    pub target: NextcloudTalkTarget,
}

/// Headers sent by Nextcloud Talk webhook.
#[derive(Debug, Clone)]
pub struct NextcloudTalkWebhookHeaders {
    /// HMAC-SHA256 signature of the request.
    pub signature: String,
    /// Random string used in signature calculation.
    pub random: String,
    /// Backend Nextcloud server URL.
    pub backend: String,
}

/// User information in Nextcloud Talk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkUser {
    /// User ID.
    pub id: String,
    /// Display name.
    pub display_name: String,
    /// Actor type (e.g., "users", "guests").
    pub actor_type: Option<String>,
}

impl NextcloudTalkUser {
    /// Returns a human-friendly display name for the user.
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

/// Room/conversation information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkRoom {
    /// Room token.
    pub token: String,
    /// Room name.
    pub name: String,
    /// Display name.
    pub display_name: String,
    /// Room type.
    #[serde(rename = "type")]
    pub room_type: NextcloudTalkRoomType,
    /// Participant count.
    pub participant_count: Option<i32>,
    /// Last activity timestamp.
    pub last_activity: Option<i64>,
}

impl NextcloudTalkRoom {
    /// Returns a human-friendly display name for the room.
    pub fn display_name(&self) -> &str {
        if self.display_name.is_empty() {
            &self.name
        } else {
            &self.display_name
        }
    }

    /// Returns whether this is a group chat.
    pub fn is_group_chat(&self) -> bool {
        matches!(
            self.room_type,
            NextcloudTalkRoomType::Group | NextcloudTalkRoomType::Public
        )
    }
}

/// Parsed incoming message context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkInboundMessage {
    /// Message ID.
    pub message_id: String,
    /// Room token.
    pub room_token: String,
    /// Room name.
    pub room_name: String,
    /// Sender user ID.
    pub sender_id: String,
    /// Sender display name.
    pub sender_name: String,
    /// Message text.
    pub text: String,
    /// Media type.
    pub media_type: String,
    /// Message timestamp (Unix timestamp).
    pub timestamp: i64,
    /// Whether this is a group chat.
    pub is_group_chat: bool,
}

/// Result from sending a message to Nextcloud Talk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkSendResult {
    /// Message ID.
    pub message_id: String,
    /// Room token.
    pub room_token: String,
    /// Timestamp.
    pub timestamp: Option<i64>,
}

/// Message payload for events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkMessagePayload {
    /// Message ID.
    pub message_id: String,
    /// Room information.
    pub room: NextcloudTalkRoom,
    /// Sender information.
    pub from_user: Option<NextcloudTalkUser>,
    /// Message text.
    pub text: Option<String>,
    /// Timestamp.
    pub timestamp: i64,
    /// Whether this is a group chat.
    pub is_group_chat: bool,
}

/// Reaction payload for events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkReactionPayload {
    /// Message ID the reaction applies to.
    pub message_id: String,
    /// Room information.
    pub room: NextcloudTalkRoom,
    /// User who reacted.
    pub from_user: Option<NextcloudTalkUser>,
    /// Reaction emoji.
    pub reaction: String,
    /// Timestamp.
    pub timestamp: i64,
}

/// World/room context payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkWorldPayload {
    /// Room information.
    pub room: NextcloudTalkRoom,
    /// Bot user ID.
    pub bot_user_id: Option<String>,
}

/// Nextcloud Talk content extension.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NextcloudTalkContent {
    /// Text content.
    pub text: Option<String>,
    /// Room token.
    pub room_token: Option<String>,
    /// Reply to message ID.
    pub reply_to: Option<String>,
    /// Reaction emoji.
    pub reaction: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            NextcloudTalkEventType::MessageReceived.to_string(),
            "NEXTCLOUD_TALK_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_room_type_display() {
        assert_eq!(NextcloudTalkRoomType::OneToOne.to_string(), "one-to-one");
        assert_eq!(NextcloudTalkRoomType::Group.to_string(), "group");
    }

    #[test]
    fn test_room_is_group_chat() {
        let room = NextcloudTalkRoom {
            token: "abc123".to_string(),
            name: "Test Room".to_string(),
            display_name: "Test Room".to_string(),
            room_type: NextcloudTalkRoomType::Group,
            participant_count: Some(5),
            last_activity: None,
        };
        assert!(room.is_group_chat());

        let dm_room = NextcloudTalkRoom {
            token: "xyz789".to_string(),
            name: "John Doe".to_string(),
            display_name: "John Doe".to_string(),
            room_type: NextcloudTalkRoomType::OneToOne,
            participant_count: Some(2),
            last_activity: None,
        };
        assert!(!dm_room.is_group_chat());
    }
}
