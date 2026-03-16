//! Type definitions for the Discord plugin
//!
//! Strong types with validation - no unknown or any types.

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::error::{DiscordError, Result};

/// Discord snowflake ID
///
/// A validated Discord snowflake - always 17-19 digits.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
#[serde(into = "String")]
pub struct Snowflake(String);

impl Snowflake {
    /// Create a new snowflake from a string
    ///
    /// # Errors
    ///
    /// Returns `DiscordError::InvalidSnowflake` if the string is not a valid snowflake.
    pub fn new(id: String) -> Result<Self> {
        Self::validate(&id)?;
        Ok(Self(id))
    }

    /// Validate a snowflake string
    fn validate(id: &str) -> Result<()> {
        if id.len() < 17 || id.len() > 19 {
            return Err(DiscordError::InvalidSnowflake(format!(
                "Snowflake must be 17-19 characters, got {}",
                id.len()
            )));
        }

        if !id.chars().all(|c| c.is_ascii_digit()) {
            return Err(DiscordError::InvalidSnowflake(
                "Snowflake must contain only digits".to_string(),
            ));
        }

        Ok(())
    }

    /// Get the inner string value
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Convert to u64
    ///
    /// # Panics
    ///
    /// Panics if the snowflake cannot be parsed as u64 (should never happen for valid snowflakes).
    pub fn as_u64(&self) -> u64 {
        self.0.parse().expect("Valid snowflake must parse as u64")
    }
}

impl fmt::Display for Snowflake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl TryFrom<String> for Snowflake {
    type Error = DiscordError;

    fn try_from(value: String) -> Result<Self> {
        Self::new(value)
    }
}

impl From<Snowflake> for String {
    fn from(snowflake: Snowflake) -> String {
        snowflake.0
    }
}

impl AsRef<str> for Snowflake {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// Discord event types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscordEventType {
    /// Message received in a channel
    MessageReceived,
    /// Message sent by the bot
    MessageSent,
    /// Slash command invoked
    SlashCommand,
    /// Modal submitted
    ModalSubmit,
    /// Reaction added
    ReactionReceived,
    /// Reaction removed
    ReactionRemoved,
    /// Bot joined a guild
    WorldJoined,
    /// Bot connected to Discord
    WorldConnected,
    /// Member joined a guild
    EntityJoined,
    /// Member left a guild
    EntityLeft,
    /// Voice state changed
    VoiceStateChanged,
    /// Channel permissions changed
    ChannelPermissionsChanged,
    /// Role permissions changed
    RolePermissionsChanged,
    /// Member roles changed
    MemberRolesChanged,
    /// Role created
    RoleCreated,
    /// Role deleted
    RoleDeleted,
}

impl fmt::Display for DiscordEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::MessageReceived => "MESSAGE_RECEIVED",
            Self::MessageSent => "MESSAGE_SENT",
            Self::SlashCommand => "SLASH_COMMAND",
            Self::ModalSubmit => "MODAL_SUBMIT",
            Self::ReactionReceived => "REACTION_RECEIVED",
            Self::ReactionRemoved => "REACTION_REMOVED",
            Self::WorldJoined => "WORLD_JOINED",
            Self::WorldConnected => "WORLD_CONNECTED",
            Self::EntityJoined => "ENTITY_JOINED",
            Self::EntityLeft => "ENTITY_LEFT",
            Self::VoiceStateChanged => "VOICE_STATE_CHANGED",
            Self::ChannelPermissionsChanged => "CHANNEL_PERMISSIONS_CHANGED",
            Self::RolePermissionsChanged => "ROLE_PERMISSIONS_CHANGED",
            Self::MemberRolesChanged => "MEMBER_ROLES_CHANGED",
            Self::RoleCreated => "ROLE_CREATED",
            Self::RoleDeleted => "ROLE_DELETED",
        };
        write!(f, "{}", s)
    }
}

/// Message payload for Discord events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordMessagePayload {
    /// Message ID
    pub message_id: Snowflake,
    /// Channel ID where message was sent
    pub channel_id: Snowflake,
    /// Guild ID (None for DMs)
    pub guild_id: Option<Snowflake>,
    /// Author user ID
    pub author_id: Snowflake,
    /// Author username
    pub author_name: String,
    /// Message content
    pub content: String,
    /// Timestamp (ISO 8601)
    pub timestamp: String,
    /// Whether message is from a bot
    pub is_bot: bool,
    /// Attachments
    pub attachments: Vec<DiscordAttachment>,
    /// Embeds
    pub embeds: Vec<DiscordEmbed>,
    /// Mentioned users
    pub mentions: Vec<Snowflake>,
}

/// Discord attachment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordAttachment {
    /// Attachment ID
    pub id: Snowflake,
    /// File name
    pub filename: String,
    /// File size in bytes
    pub size: u64,
    /// URL to the attachment
    pub url: String,
    /// Proxy URL
    pub proxy_url: String,
    /// MIME content type
    pub content_type: Option<String>,
    /// Height (for images)
    pub height: Option<u32>,
    /// Width (for images)
    pub width: Option<u32>,
}

/// Discord embed
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscordEmbed {
    /// Title
    pub title: Option<String>,
    /// Description
    pub description: Option<String>,
    /// URL
    pub url: Option<String>,
    /// Timestamp
    pub timestamp: Option<String>,
    /// Color (as integer)
    pub color: Option<u32>,
    /// Footer
    pub footer: Option<DiscordEmbedFooter>,
    /// Image
    pub image: Option<DiscordEmbedMedia>,
    /// Thumbnail
    pub thumbnail: Option<DiscordEmbedMedia>,
    /// Author
    pub author: Option<DiscordEmbedAuthor>,
    /// Fields
    pub fields: Vec<DiscordEmbedField>,
}

/// Discord embed footer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordEmbedFooter {
    /// Footer text
    pub text: String,
    /// Footer icon URL
    pub icon_url: Option<String>,
}

/// Discord embed media (image/thumbnail/video)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordEmbedMedia {
    /// Media URL
    pub url: String,
    /// Proxy URL
    pub proxy_url: Option<String>,
    /// Height
    pub height: Option<u32>,
    /// Width
    pub width: Option<u32>,
}

/// Discord embed author
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordEmbedAuthor {
    /// Author name
    pub name: String,
    /// Author URL
    pub url: Option<String>,
    /// Author icon URL
    pub icon_url: Option<String>,
}

/// Discord embed field
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordEmbedField {
    /// Field name
    pub name: String,
    /// Field value
    pub value: String,
    /// Whether field should be inline
    pub inline: bool,
}

/// Reaction payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordReactionPayload {
    /// User who reacted
    pub user_id: Snowflake,
    /// Channel ID
    pub channel_id: Snowflake,
    /// Message ID
    pub message_id: Snowflake,
    /// Guild ID (None for DMs)
    pub guild_id: Option<Snowflake>,
    /// Emoji name or unicode
    pub emoji: String,
    /// Whether this is a custom emoji
    pub is_custom_emoji: bool,
    /// Custom emoji ID (if custom)
    pub emoji_id: Option<Snowflake>,
}

/// Voice state payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordVoiceStatePayload {
    /// User ID
    pub user_id: Snowflake,
    /// Guild ID
    pub guild_id: Snowflake,
    /// Channel ID (None if user left voice)
    pub channel_id: Option<Snowflake>,
    /// Session ID
    pub session_id: String,
    /// Whether user is muted
    pub is_muted: bool,
    /// Whether user is deafened
    pub is_deafened: bool,
    /// Whether user is self-muted
    pub is_self_muted: bool,
    /// Whether user is self-deafened
    pub is_self_deafened: bool,
    /// Whether user is streaming
    pub is_streaming: bool,
    /// Whether user has video on
    pub is_video_on: bool,
}

/// Guild/world joined payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordWorldPayload {
    /// Guild ID
    pub guild_id: Snowflake,
    /// Guild name
    pub guild_name: String,
    /// Member count
    pub member_count: u32,
    /// Available text channels
    pub text_channels: Vec<DiscordChannelInfo>,
    /// Available voice channels
    pub voice_channels: Vec<DiscordChannelInfo>,
}

/// Basic channel information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordChannelInfo {
    /// Channel ID
    pub id: Snowflake,
    /// Channel name
    pub name: String,
    /// Channel type
    pub channel_type: DiscordChannelType,
}

/// Discord channel types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscordChannelType {
    /// Text channel
    Text,
    /// DM channel
    Dm,
    /// Voice channel
    Voice,
    /// Group DM
    GroupDm,
    /// Category
    Category,
    /// Announcement/news channel
    Announcement,
    /// Thread
    Thread,
    /// Stage channel
    Stage,
    /// Forum channel
    Forum,
}

/// Member joined/left payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordMemberPayload {
    /// User ID
    pub user_id: Snowflake,
    /// Username
    pub username: String,
    /// Display name
    pub display_name: Option<String>,
    /// Guild ID
    pub guild_id: Snowflake,
    /// Roles
    pub roles: Vec<Snowflake>,
    /// Join timestamp (for join events)
    pub joined_at: Option<String>,
}

/// Discord settings for a channel/guild
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscordSettings {
    /// Channel IDs where bot is active
    pub allowed_channel_ids: Vec<Snowflake>,
    /// Whether to ignore bot messages
    pub should_ignore_bot_messages: bool,
    /// Whether to ignore DMs
    pub should_ignore_direct_messages: bool,
    /// Whether to only respond when mentioned
    pub should_respond_only_to_mentions: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_snowflake_valid() {
        assert!(Snowflake::new("12345678901234567".to_string()).is_ok());
        assert!(Snowflake::new("123456789012345678".to_string()).is_ok());
        assert!(Snowflake::new("1234567890123456789".to_string()).is_ok());
    }

    #[test]
    fn test_snowflake_invalid() {
        assert!(Snowflake::new("1234567890123456".to_string()).is_err());
        assert!(Snowflake::new("12345678901234567890".to_string()).is_err());
        assert!(Snowflake::new("1234567890123456a".to_string()).is_err());
        assert!(Snowflake::new("".to_string()).is_err());
    }

    #[test]
    fn test_snowflake_as_u64() {
        let s = Snowflake::new("123456789012345678".to_string()).unwrap();
        assert_eq!(s.as_u64(), 123456789012345678u64);
    }

    #[test]
    fn test_event_type_display() {
        assert_eq!(
            DiscordEventType::MessageReceived.to_string(),
            "MESSAGE_RECEIVED"
        );
    }
}
