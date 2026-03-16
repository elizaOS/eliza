//! Types for the Tlon plugin.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Event types emitted by the Tlon plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TlonEventType {
    /// The bot connected to the Urbit ship.
    WorldJoined,
    /// The bot is ready to receive updates.
    WorldConnected,
    /// The bot disconnected from the Urbit ship.
    WorldLeft,
    /// A ship joined a channel.
    EntityJoined,
    /// A ship left a channel.
    EntityLeft,
    /// A message was received.
    MessageReceived,
    /// A message was sent by the bot.
    MessageSent,
    /// A DM was received.
    DmReceived,
    /// A group message was received.
    GroupMessageReceived,
    /// Connection error occurred.
    ConnectionError,
    /// Reconnection succeeded.
    Reconnected,
}

impl fmt::Display for TlonEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::WorldJoined => "TLON_WORLD_JOINED",
            Self::WorldConnected => "TLON_WORLD_CONNECTED",
            Self::WorldLeft => "TLON_WORLD_LEFT",
            Self::EntityJoined => "TLON_ENTITY_JOINED",
            Self::EntityLeft => "TLON_ENTITY_LEFT",
            Self::MessageReceived => "TLON_MESSAGE_RECEIVED",
            Self::MessageSent => "TLON_MESSAGE_SENT",
            Self::DmReceived => "TLON_DM_RECEIVED",
            Self::GroupMessageReceived => "TLON_GROUP_MESSAGE_RECEIVED",
            Self::ConnectionError => "TLON_CONNECTION_ERROR",
            Self::Reconnected => "TLON_RECONNECTED",
        };
        write!(f, "{}", s)
    }
}

/// Tlon channel types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TlonChannelType {
    /// Direct message.
    Dm,
    /// Group channel.
    Group,
    /// Thread reply.
    Thread,
}

impl fmt::Display for TlonChannelType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Dm => "dm",
            Self::Group => "group",
            Self::Thread => "thread",
        };
        write!(f, "{}", s)
    }
}

/// Urbit ship information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonShip {
    /// Ship name (without ~).
    pub name: String,
    /// Display name if available.
    pub display_name: Option<String>,
    /// Ship avatar URL.
    pub avatar: Option<String>,
}

impl TlonShip {
    /// Creates a new ship with just a name.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            display_name: None,
            avatar: None,
        }
    }

    /// Returns the ship name with ~ prefix.
    pub fn formatted(&self) -> String {
        format!("~{}", self.name)
    }
}

/// Tlon chat/channel information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonChat {
    /// Channel identifier.
    pub id: String,
    /// Channel type.
    #[serde(rename = "type")]
    pub channel_type: TlonChannelType,
    /// Channel name/title.
    pub name: Option<String>,
    /// Host ship for group channels.
    pub host_ship: Option<String>,
    /// Channel description.
    pub description: Option<String>,
}

impl TlonChat {
    /// Creates a new DM chat.
    pub fn dm(ship: &str) -> Self {
        Self {
            id: ship.to_string(),
            channel_type: TlonChannelType::Dm,
            name: Some(format!("DM with ~{}", ship)),
            host_ship: None,
            description: None,
        }
    }

    /// Creates a new group chat.
    pub fn group(channel_nest: &str, name: Option<String>, host_ship: Option<String>) -> Self {
        Self {
            id: channel_nest.to_string(),
            channel_type: TlonChannelType::Group,
            name,
            host_ship,
            description: None,
        }
    }
}

/// Payload for received messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonMessagePayload {
    /// The message ID.
    pub message_id: String,
    /// The chat where the message was received.
    pub chat: TlonChat,
    /// The sender ship.
    pub from_ship: TlonShip,
    /// Message text content.
    pub text: String,
    /// Timestamp (ms since epoch).
    pub timestamp: i64,
    /// Parent message ID for thread replies.
    pub reply_to_id: Option<String>,
}

/// Payload for sent messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonMessageSentPayload {
    /// The message ID.
    pub message_id: String,
    /// Target chat.
    pub chat: TlonChat,
    /// Message text.
    pub text: String,
    /// Whether it was a reply.
    pub is_reply: bool,
}

/// Payload for world/connection events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonWorldPayload {
    /// The connected ship.
    pub ship: TlonShip,
    /// Available DM conversations.
    pub dm_conversations: Vec<String>,
    /// Available group channels.
    pub group_channels: Vec<String>,
}

/// Payload for entity (ship) events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonEntityPayload {
    /// The ship involved.
    pub ship: TlonShip,
    /// The chat context.
    pub chat: TlonChat,
    /// Action type.
    pub action: EntityAction,
}

/// Entity action type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityAction {
    /// Entity joined.
    Joined,
    /// Entity left.
    Left,
    /// Entity was updated.
    Updated,
}

/// Tlon content (message body).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TlonContent {
    /// Text content.
    pub text: Option<String>,
    /// Ship sender.
    pub ship: Option<String>,
    /// Channel nest for group messages.
    pub channel_nest: Option<String>,
    /// Reply to message ID.
    pub reply_to_id: Option<String>,
}

/// Story content (array of verse elements).
pub type TlonStory = Vec<TlonVerse>;

/// Verse element.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonVerse {
    /// Inline content.
    pub inline: Option<Vec<TlonInline>>,
    /// Block content.
    pub block: Option<TlonBlock>,
}

/// Inline content element.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TlonInline {
    /// Plain text.
    Text(String),
    /// Element with formatting.
    Element(TlonInlineElement),
}

/// Inline element with formatting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonInlineElement {
    /// Ship mention.
    pub ship: Option<String>,
    /// Link.
    pub link: Option<TlonLink>,
    /// Bold text.
    pub bold: Option<Vec<TlonInline>>,
    /// Italic text.
    pub italic: Option<Vec<TlonInline>>,
    /// Strikethrough text.
    pub strike: Option<Vec<TlonInline>>,
    /// Inline code.
    pub code: Option<String>,
    /// Blockquote.
    pub blockquote: Option<Vec<TlonInline>>,
}

/// Link element.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonLink {
    /// URL.
    pub href: String,
    /// Link text.
    pub content: String,
}

/// Block content element.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonBlock {
    /// Image block.
    pub image: Option<TlonImage>,
    /// Code block.
    pub code: Option<TlonCodeBlock>,
    /// Header block.
    pub header: Option<TlonHeader>,
    /// List block.
    pub listing: Option<TlonListing>,
    /// Horizontal rule.
    pub rule: Option<bool>,
}

/// Image block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonImage {
    /// Image source URL.
    pub src: String,
    /// Alt text.
    pub alt: Option<String>,
    /// Width.
    pub width: Option<u32>,
    /// Height.
    pub height: Option<u32>,
}

/// Code block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonCodeBlock {
    /// Code content.
    pub code: String,
    /// Language.
    pub lang: Option<String>,
}

/// Header block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonHeader {
    /// Header content.
    pub content: Vec<TlonInline>,
    /// Header level.
    pub tag: String,
}

/// List block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonListing {
    /// List type.
    #[serde(rename = "type")]
    pub list_type: String,
    /// List items.
    pub items: Vec<Vec<TlonInline>>,
}

/// Subscription information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlonSubscription {
    /// Subscription ID.
    pub id: i64,
    /// App name.
    pub app: String,
    /// Subscription path.
    pub path: String,
}

/// Settings for the Tlon plugin runtime.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TlonSettings {
    /// Ship name.
    pub ship: String,
    /// Ships allowed to DM.
    pub dm_allowlist: Vec<String>,
    /// Group channels to monitor.
    pub group_channels: Vec<String>,
    /// Auto-discover channels.
    pub auto_discover_channels: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_type_display() {
        assert_eq!(TlonEventType::MessageReceived.to_string(), "TLON_MESSAGE_RECEIVED");
        assert_eq!(TlonEventType::DmReceived.to_string(), "TLON_DM_RECEIVED");
    }

    #[test]
    fn test_channel_type_display() {
        assert_eq!(TlonChannelType::Dm.to_string(), "dm");
        assert_eq!(TlonChannelType::Group.to_string(), "group");
    }

    #[test]
    fn test_ship_formatted() {
        let ship = TlonShip::new("sampel-palnet");
        assert_eq!(ship.formatted(), "~sampel-palnet");
    }

    #[test]
    fn test_chat_dm() {
        let chat = TlonChat::dm("sampel-palnet");
        assert_eq!(chat.channel_type, TlonChannelType::Dm);
        assert!(chat.name.unwrap().contains("sampel-palnet"));
    }
}
