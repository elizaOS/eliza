//! Type definitions for the Roblox plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Roblox user information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxUser {
    /// Roblox user ID
    pub id: u64,
    /// Roblox username
    pub username: String,
    /// Display name
    pub display_name: String,
    /// Avatar thumbnail URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// Account creation date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    /// Whether account is banned
    #[serde(default)]
    pub is_banned: bool,
}

/// Roblox player session in a game.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxPlayerSession {
    /// Player user info
    pub user: RobloxUser,
    /// Server job ID
    pub job_id: String,
    /// Place ID the player is in
    pub place_id: String,
    /// When the player joined
    pub joined_at: DateTime<Utc>,
}

/// Message from a Roblox game.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxGameMessage {
    /// Unique message ID
    pub id: String,
    /// Sending user
    pub user: RobloxUser,
    /// Message content
    pub content: String,
    /// Server job ID
    pub job_id: String,
    /// Place ID
    pub place_id: String,
    /// Message timestamp
    pub timestamp: DateTime<Utc>,
    /// Optional context data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<std::collections::HashMap<String, String>>,
}

/// Response to send back to Roblox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxResponse {
    /// Response content
    pub content: String,
    /// Optional action to trigger in-game
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<RobloxGameAction>,
    /// Whether the message was flagged
    #[serde(default)]
    pub flagged: bool,
}

/// Game action to execute in Roblox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxGameAction {
    /// Action name/type
    pub name: String,
    /// Action parameters
    pub parameters: serde_json::Value,
    /// Target player IDs (empty = all)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_player_ids: Option<Vec<u64>>,
}

/// Data store entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataStoreEntry<T = serde_json::Value> {
    /// Entry key
    pub key: String,
    /// Entry value
    pub value: T,
    /// Entry version
    pub version: String,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
}

/// Messaging service message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagingServiceMessage {
    /// Topic name
    pub topic: String,
    /// Message data
    pub data: serde_json::Value,
    /// Sender information
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<MessageSender>,
}

/// Message sender information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSender {
    /// Agent ID
    pub agent_id: Uuid,
    /// Agent name
    pub agent_name: String,
}

/// Roblox event types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RobloxEventType {
    /// Player joined the game
    PlayerJoined,
    /// Player left the game
    PlayerLeft,
    /// Player sent a chat message
    PlayerMessage,
    /// Player triggered a game event
    GameEvent,
    /// Webhook received
    WebhookReceived,
}

impl RobloxEventType {
    /// Get the string representation of the event type.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PlayerJoined => "roblox:player_joined",
            Self::PlayerLeft => "roblox:player_left",
            Self::PlayerMessage => "roblox:player_message",
            Self::GameEvent => "roblox:game_event",
            Self::WebhookReceived => "roblox:webhook_received",
        }
    }
}

/// Server information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxServerInfo {
    /// Job ID
    pub job_id: String,
    /// Place ID
    pub place_id: String,
    /// Current player count
    pub player_count: u32,
    /// Maximum players
    pub max_players: u32,
    /// Server region
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// Server uptime in seconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime: Option<u64>,
}

/// Experience/Universe information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxExperienceInfo {
    /// Universe ID
    pub universe_id: String,
    /// Experience name
    pub name: String,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Creator info
    pub creator: ExperienceCreator,
    /// Current active player count
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playing: Option<u64>,
    /// Total visits
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visits: Option<u64>,
    /// Root place ID
    pub root_place_id: String,
}

/// Experience creator information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceCreator {
    /// Creator ID
    pub id: u64,
    /// Creator type
    pub creator_type: CreatorType,
    /// Creator name
    pub name: String,
}

/// Creator type enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CreatorType {
    /// Individual user
    User,
    /// Group
    Group,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roblox_user() {
        let user = RobloxUser {
            id: 12345,
            username: "testuser".to_string(),
            display_name: "Test User".to_string(),
            avatar_url: None,
            created_at: None,
            is_banned: false,
        };

        assert_eq!(user.id, 12345);
        assert_eq!(user.username, "testuser");
    }

    #[test]
    fn test_event_type_as_str() {
        assert_eq!(RobloxEventType::PlayerJoined.as_str(), "roblox:player_joined");
        assert_eq!(RobloxEventType::PlayerLeft.as_str(), "roblox:player_left");
        assert_eq!(RobloxEventType::PlayerMessage.as_str(), "roblox:player_message");
    }
}

