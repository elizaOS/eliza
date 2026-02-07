use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
/// Event types emitted by the Mattermost plugin.
pub enum MattermostEventType {
    /// The bot joined a Mattermost "world" (team/channel) context.
    WorldJoined,
    /// The bot connected successfully and is ready to receive updates.
    WorldConnected,
    /// The bot left a Mattermost "world" context.
    WorldLeft,
    /// A user joined a channel.
    EntityJoined,
    /// A user left a channel.
    EntityLeft,
    /// A user's membership or profile was updated.
    EntityUpdated,
    /// A message was received.
    MessageReceived,
    /// A message was sent by the bot.
    MessageSent,
    /// A reaction was received.
    ReactionReceived,
    /// An interaction was received.
    InteractionReceived,
}

impl fmt::Display for MattermostEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::WorldJoined => "MATTERMOST_WORLD_JOINED",
            Self::WorldConnected => "MATTERMOST_WORLD_CONNECTED",
            Self::WorldLeft => "MATTERMOST_WORLD_LEFT",
            Self::EntityJoined => "MATTERMOST_ENTITY_JOINED",
            Self::EntityLeft => "MATTERMOST_ENTITY_LEFT",
            Self::EntityUpdated => "MATTERMOST_ENTITY_UPDATED",
            Self::MessageReceived => "MATTERMOST_MESSAGE_RECEIVED",
            Self::MessageSent => "MATTERMOST_MESSAGE_SENT",
            Self::ReactionReceived => "MATTERMOST_REACTION_RECEIVED",
            Self::InteractionReceived => "MATTERMOST_INTERACTION_RECEIVED",
        };
        write!(f, "{}", s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
/// Mattermost channel type.
pub enum MattermostChannelType {
    /// One-on-one direct message.
    #[serde(rename = "D")]
    Direct,
    /// Group direct message.
    #[serde(rename = "G")]
    Group,
    /// Public channel.
    #[serde(rename = "O")]
    Open,
    /// Private channel.
    #[serde(rename = "P")]
    Private,
}

impl fmt::Display for MattermostChannelType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Direct => "D",
            Self::Group => "G",
            Self::Open => "O",
            Self::Private => "P",
        };
        write!(f, "{}", s)
    }
}

impl MattermostChannelType {
    /// Parse channel type from string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_uppercase().as_str() {
            "D" => Some(Self::Direct),
            "G" => Some(Self::Group),
            "O" => Some(Self::Open),
            "P" => Some(Self::Private),
            _ => None,
        }
    }

    /// Returns the channel kind.
    pub fn kind(&self) -> ChannelKind {
        match self {
            Self::Direct => ChannelKind::Dm,
            Self::Group => ChannelKind::Group,
            Self::Open | Self::Private => ChannelKind::Channel,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Simplified channel kind.
pub enum ChannelKind {
    /// Direct message.
    Dm,
    /// Group message.
    Group,
    /// Regular channel.
    Channel,
}

/// Mattermost user information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostUser {
    /// User ID.
    pub id: String,
    /// Username (without @).
    pub username: Option<String>,
    /// Nickname.
    pub nickname: Option<String>,
    /// First name.
    pub first_name: Option<String>,
    /// Last name.
    pub last_name: Option<String>,
    /// Email address.
    pub email: Option<String>,
    /// Position/title.
    pub position: Option<String>,
    /// User roles.
    pub roles: Option<String>,
    /// Whether user is a bot.
    #[serde(default)]
    pub is_bot: bool,
    /// Bot description if is_bot is true.
    pub bot_description: Option<String>,
    /// Creation timestamp.
    pub create_at: Option<i64>,
    /// Last update timestamp.
    pub update_at: Option<i64>,
    /// Deletion timestamp (0 if not deleted).
    pub delete_at: Option<i64>,
}

impl MattermostUser {
    /// Returns a human-friendly display name for the user.
    pub fn display_name(&self) -> String {
        if let Some(nickname) = &self.nickname {
            let trimmed = nickname.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }

        match (&self.first_name, &self.last_name) {
            (Some(first), Some(last)) => {
                let first = first.trim();
                let last = last.trim();
                if !first.is_empty() && !last.is_empty() {
                    return format!("{} {}", first, last);
                }
                if !first.is_empty() {
                    return first.to_string();
                }
                if !last.is_empty() {
                    return last.to_string();
                }
            }
            (Some(first), None) => {
                let trimmed = first.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
            (None, Some(last)) => {
                let trimmed = last.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
            (None, None) => {}
        }

        self.username
            .as_ref()
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| self.id.clone())
    }
}

/// Mattermost channel information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostChannel {
    /// Channel ID.
    pub id: String,
    /// Channel name (URL-safe).
    pub name: Option<String>,
    /// Display name.
    pub display_name: Option<String>,
    /// Channel type (D, G, O, P).
    #[serde(rename = "type")]
    pub channel_type: Option<String>,
    /// Team ID this channel belongs to.
    pub team_id: Option<String>,
    /// Channel header.
    pub header: Option<String>,
    /// Channel purpose.
    pub purpose: Option<String>,
    /// Creator user ID.
    pub creator_id: Option<String>,
    /// Creation timestamp.
    pub create_at: Option<i64>,
    /// Last update timestamp.
    pub update_at: Option<i64>,
    /// Deletion timestamp (0 if not deleted).
    pub delete_at: Option<i64>,
}

impl MattermostChannel {
    /// Returns a human-friendly display name for the channel.
    pub fn display_name_str(&self) -> String {
        self.display_name
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                self.name
                    .as_ref()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| self.id.clone())
    }

    /// Returns the channel type enum.
    pub fn get_channel_type(&self) -> Option<MattermostChannelType> {
        self.channel_type
            .as_ref()
            .and_then(|t| MattermostChannelType::from_str(t))
    }

    /// Returns the channel kind.
    pub fn kind(&self) -> ChannelKind {
        self.get_channel_type()
            .map(|t| t.kind())
            .unwrap_or(ChannelKind::Channel)
    }
}

/// Mattermost post (message) information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostPost {
    /// Post ID.
    pub id: String,
    /// User ID who created the post.
    pub user_id: Option<String>,
    /// Channel ID where the post was created.
    pub channel_id: Option<String>,
    /// Post message content.
    pub message: Option<String>,
    /// File attachment IDs.
    pub file_ids: Option<Vec<String>>,
    /// Post type (empty for regular posts).
    #[serde(rename = "type")]
    pub post_type: Option<String>,
    /// Root post ID (for thread replies).
    pub root_id: Option<String>,
    /// Parent post ID.
    pub parent_id: Option<String>,
    /// Creation timestamp.
    pub create_at: Option<i64>,
    /// Last update timestamp.
    pub update_at: Option<i64>,
    /// Deletion timestamp (0 if not deleted).
    pub delete_at: Option<i64>,
    /// Edit timestamp.
    pub edit_at: Option<i64>,
    /// Post properties.
    pub props: Option<serde_json::Value>,
    /// Hashtags in the post.
    pub hashtags: Option<String>,
}

impl MattermostPost {
    /// Returns true if this is a system post.
    pub fn is_system_post(&self) -> bool {
        self.post_type
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false)
    }

    /// Returns the trimmed message content.
    pub fn message_text(&self) -> String {
        self.message
            .as_ref()
            .map(|m| m.trim().to_string())
            .unwrap_or_default()
    }
}

/// Mattermost file information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostFileInfo {
    /// File ID.
    pub id: String,
    /// File name.
    pub name: Option<String>,
    /// MIME type.
    pub mime_type: Option<String>,
    /// File size in bytes.
    pub size: Option<i64>,
    /// File extension.
    pub extension: Option<String>,
    /// Post ID this file is attached to.
    pub post_id: Option<String>,
    /// Channel ID.
    pub channel_id: Option<String>,
    /// Creation timestamp.
    pub create_at: Option<i64>,
}

/// Mattermost team information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostTeam {
    /// Team ID.
    pub id: String,
    /// Team name (URL-safe).
    pub name: Option<String>,
    /// Display name.
    pub display_name: Option<String>,
    /// Team description.
    pub description: Option<String>,
    /// Team type (O for open, I for invite-only).
    #[serde(rename = "type")]
    pub team_type: Option<String>,
    /// Creation timestamp.
    pub create_at: Option<i64>,
    /// Last update timestamp.
    pub update_at: Option<i64>,
    /// Deletion timestamp.
    pub delete_at: Option<i64>,
}

/// WebSocket event payload from Mattermost.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostWebSocketEvent {
    /// Event type.
    pub event: Option<String>,
    /// Sequence number.
    pub seq: Option<i64>,
    /// Event data.
    pub data: Option<serde_json::Value>,
    /// Broadcast information.
    pub broadcast: Option<MattermostBroadcast>,
}

/// WebSocket broadcast information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostBroadcast {
    /// Channel ID.
    pub channel_id: Option<String>,
    /// Team ID.
    pub team_id: Option<String>,
    /// User ID.
    pub user_id: Option<String>,
    /// Users to omit.
    pub omit_users: Option<serde_json::Value>,
}

/// Payload for a received message event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostMessagePayload {
    /// Post information.
    pub post: MattermostPost,
    /// Channel information.
    pub channel: MattermostChannel,
    /// User who sent the message.
    pub user: Option<MattermostUser>,
    /// Team information.
    pub team: Option<MattermostTeam>,
}

/// Payload for a reaction event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostReactionPayload {
    /// Post ID the reaction applies to.
    pub post_id: String,
    /// User who reacted.
    pub user: Option<MattermostUser>,
    /// Emoji name.
    pub emoji_name: String,
    /// Timestamp.
    pub create_at: Option<i64>,
}

/// Payload for world/channel events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostWorldPayload {
    /// Channel information.
    pub channel: MattermostChannel,
    /// Team information.
    pub team: Option<MattermostTeam>,
    /// Bot username.
    pub bot_username: Option<String>,
}

/// Payload for entity (user) events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MattermostEntityPayload {
    /// User information.
    pub user: MattermostUser,
    /// Channel information.
    pub channel: MattermostChannel,
    /// Action type.
    pub action: EntityAction,
}

/// Entity action type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityAction {
    /// Entity joined the channel.
    Joined,
    /// Entity left the channel.
    Left,
    /// Entity information was updated.
    Updated,
}

/// Mattermost content with optional attachments.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MattermostContent {
    /// Text content.
    pub text: Option<String>,
    /// File IDs.
    pub file_ids: Option<Vec<String>>,
    /// Root post ID for threading.
    pub root_id: Option<String>,
    /// Post properties.
    pub props: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            MattermostEventType::MessageReceived.to_string(),
            "MATTERMOST_MESSAGE_RECEIVED"
        );
    }

    #[test]
    fn test_channel_type_display() {
        assert_eq!(MattermostChannelType::Direct.to_string(), "D");
        assert_eq!(MattermostChannelType::Open.to_string(), "O");
    }

    #[test]
    fn test_channel_type_from_str() {
        assert_eq!(
            MattermostChannelType::from_str("D"),
            Some(MattermostChannelType::Direct)
        );
        assert_eq!(
            MattermostChannelType::from_str("o"),
            Some(MattermostChannelType::Open)
        );
        assert_eq!(MattermostChannelType::from_str("X"), None);
    }

    #[test]
    fn test_user_display_name() {
        let user = MattermostUser {
            id: "user123".to_string(),
            username: Some("testuser".to_string()),
            nickname: None,
            first_name: Some("Test".to_string()),
            last_name: Some("User".to_string()),
            email: None,
            position: None,
            roles: None,
            is_bot: false,
            bot_description: None,
            create_at: None,
            update_at: None,
            delete_at: None,
        };
        assert_eq!(user.display_name(), "Test User");

        let user_nickname = MattermostUser {
            nickname: Some("Testy".to_string()),
            ..user.clone()
        };
        assert_eq!(user_nickname.display_name(), "Testy");
    }

    #[test]
    fn test_post_is_system() {
        let regular_post = MattermostPost {
            id: "post123".to_string(),
            user_id: None,
            channel_id: None,
            message: Some("Hello".to_string()),
            file_ids: None,
            post_type: None,
            root_id: None,
            parent_id: None,
            create_at: None,
            update_at: None,
            delete_at: None,
            edit_at: None,
            props: None,
            hashtags: None,
        };
        assert!(!regular_post.is_system_post());

        let system_post = MattermostPost {
            post_type: Some("system_join_channel".to_string()),
            ..regular_post
        };
        assert!(system_post.is_system_post());
    }
}
