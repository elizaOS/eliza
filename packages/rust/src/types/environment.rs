//! Environment types (Rust-native)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::primitives::UUID;

/// Represents a world (server, guild, or top-level container).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub id: UUID,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub agent_id: UUID,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_server_id: Option<UUID>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<WorldMetadata>,
}

/// World metadata.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership: Option<WorldOwnership>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub roles: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// World ownership metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldOwnership {
    pub owner_id: UUID,
}

/// Room metadata (dynamic key-value pairs).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMetadata {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub values: HashMap<String, serde_json::Value>,
}

/// Represents a room (channel, chat, or conversation container).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: UUID,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    pub source: String,
    #[serde(rename = "type")]
    pub room_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_server_id: Option<UUID>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<RoomMetadata>,
}

/// Room participant with entity details.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub id: UUID,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<Entity>,
}

/// Entity component - extensible data attached to entities.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: UUID,
    pub entity_id: UUID,
    pub agent_id: UUID,
    pub room_id: UUID,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_entity_id: Option<UUID>,
    #[serde(rename = "type")]
    pub component_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Represents an entity (user, agent, or other actor).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<Vec<Component>>,
}

/// Represents a relationship between entities.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: UUID,
    pub source_entity_id: UUID,
    pub target_entity_id: UUID,
    pub agent_id: UUID,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}
