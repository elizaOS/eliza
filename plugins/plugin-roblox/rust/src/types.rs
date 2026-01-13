#![allow(missing_docs)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxUser {
    pub id: u64,
    pub username: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub is_banned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxPlayerSession {
    pub user: RobloxUser,
    pub job_id: String,
    pub place_id: String,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxGameMessage {
    pub id: String,
    pub user: RobloxUser,
    pub content: String,
    pub job_id: String,
    pub place_id: String,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxResponse {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<RobloxGameAction>,
    #[serde(default)]
    pub flagged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxGameAction {
    pub name: String,
    pub parameters: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_player_ids: Option<Vec<u64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataStoreEntry<T = serde_json::Value> {
    pub key: String,
    pub value: T,
    pub version: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagingServiceMessage {
    pub topic: String,
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<MessageSender>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSender {
    pub agent_id: Uuid,
    pub agent_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RobloxEventType {
    PlayerJoined,
    PlayerLeft,
    PlayerMessage,
    GameEvent,
    WebhookReceived,
}

impl RobloxEventType {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxServerInfo {
    pub job_id: String,
    pub place_id: String,
    pub player_count: u32,
    pub max_players: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobloxExperienceInfo {
    pub universe_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub creator: ExperienceCreator,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playing: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visits: Option<u64>,
    pub root_place_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceCreator {
    pub id: u64,
    pub creator_type: CreatorType,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CreatorType {
    User,
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
        assert_eq!(
            RobloxEventType::PlayerJoined.as_str(),
            "roblox:player_joined"
        );
        assert_eq!(RobloxEventType::PlayerLeft.as_str(), "roblox:player_left");
        assert_eq!(
            RobloxEventType::PlayerMessage.as_str(),
            "roblox:player_message"
        );
    }
}
