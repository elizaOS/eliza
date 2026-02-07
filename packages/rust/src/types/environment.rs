//! Environment types (Rust-native)
//!
//! This module defines the core environment types for worlds, rooms, entities,
//! and their relationships within the elizaOS runtime.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::primitives::UUID;

/// Represents a world (server, guild, or top-level container).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    /// Unique identifier for this world.
    pub id: UUID,
    /// Display name of the world.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// ID of the agent that owns this world.
    pub agent_id: UUID,
    /// Optional message server ID for platform integration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_server_id: Option<UUID>,
    /// Additional metadata for this world.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<WorldMetadata>,
}

/// World metadata containing ownership and role information.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldMetadata {
    /// Ownership information for the world.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership: Option<WorldOwnership>,
    /// Role mappings (role name to description or permissions).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub roles: HashMap<String, String>,
    /// Additional extensible metadata.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// World ownership metadata.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldOwnership {
    /// ID of the entity that owns this world.
    pub owner_id: UUID,
}

/// Room metadata (dynamic key-value pairs).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMetadata {
    /// Extensible key-value metadata for the room.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub values: HashMap<String, serde_json::Value>,
}

/// Represents a room (channel, chat, or conversation container).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    /// Unique identifier for this room.
    pub id: UUID,
    /// Display name of the room.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// ID of the agent associated with this room.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    /// Source platform (e.g., "discord", "telegram").
    pub source: String,
    /// Type of room (e.g., "dm", "group", "channel").
    #[serde(rename = "type")]
    pub room_type: String,
    /// Platform-specific channel identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Optional message server ID for platform integration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_server_id: Option<UUID>,
    /// ID of the world this room belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// Additional metadata for this room.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<RoomMetadata>,
}

/// Room participant with entity details.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    /// Unique identifier for this participant.
    pub id: UUID,
    /// Associated entity details.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<Entity>,
}

/// Entity component - extensible data attached to entities.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    /// Unique identifier for this component.
    pub id: UUID,
    /// ID of the entity this component belongs to.
    pub entity_id: UUID,
    /// ID of the agent that created this component.
    pub agent_id: UUID,
    /// ID of the room context for this component.
    pub room_id: UUID,
    /// ID of the world this component belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// ID of the source entity that created this component.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_entity_id: Option<UUID>,
    /// Type of this component (e.g., "profile", "settings").
    #[serde(rename = "type")]
    pub component_type: String,
    /// Timestamp when this component was created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Component-specific data payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Represents an entity (user, agent, or other actor).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    /// Unique identifier for this entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Known names or aliases for this entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
    /// Additional metadata about this entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// ID of the agent associated with this entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    /// Components attached to this entity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<Vec<Component>>,
}

/// Represents a relationship between entities.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    /// Unique identifier for this relationship.
    pub id: UUID,
    /// ID of the source entity in this relationship.
    pub source_entity_id: UUID,
    /// ID of the target entity in this relationship.
    pub target_entity_id: UUID,
    /// ID of the agent that created this relationship.
    pub agent_id: UUID,
    /// Tags describing the relationship type.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Additional metadata about the relationship.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}
