//! Environment types for elizaOS
//!
//! Contains Entity, Room, World, Component, Relationship, and related types.

use super::{Metadata, UUID};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Component attached to an entity
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    /// Unique identifier
    pub id: UUID,
    /// Entity this component belongs to
    pub entity_id: UUID,
    /// Agent ID
    pub agent_id: UUID,
    /// Room ID
    pub room_id: UUID,
    /// World ID
    pub world_id: UUID,
    /// Source entity ID
    pub source_entity_id: UUID,
    /// Component type name
    #[serde(rename = "type")]
    pub component_type: String,
    /// Creation timestamp
    pub created_at: i64,
    /// Component data
    pub data: Metadata,
}

/// Represents a user/entity account
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    /// Unique identifier, optional on creation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Names of the entity
    pub names: Vec<String>,
    /// Additional metadata
    pub metadata: Metadata,
    /// Agent ID this entity is related to
    pub agent_id: UUID,
    /// Optional array of components
    #[serde(skip_serializing_if = "Option::is_none")]
    pub components: Option<Vec<Component>>,
}

impl Entity {
    /// Create a new entity with the given name
    pub fn new(name: &str, agent_id: UUID) -> Self {
        Entity {
            id: Some(UUID::new_v4()),
            names: vec![name.to_string()],
            metadata: HashMap::new(),
            agent_id,
            components: None,
        }
    }
}

/// Defines roles within a system
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Role {
    /// Highest level of control
    Owner,
    /// Administrative privileges
    Admin,
    /// No specific role
    #[default]
    None,
}

/// World ownership metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldOwnership {
    /// Owner ID
    pub owner_id: String,
}

/// World metadata
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldMetadata {
    /// Ownership information
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership: Option<WorldOwnership>,
    /// Role assignments
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<HashMap<String, Role>>,
    /// Additional metadata
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Represents a world/server
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    /// Unique identifier
    pub id: UUID,
    /// World name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Agent ID
    pub agent_id: UUID,
    /// Message server ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_server_id: Option<UUID>,
    /// World metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<WorldMetadata>,
}

impl World {
    /// Create a new world
    pub fn new(name: &str, agent_id: UUID) -> Self {
        World {
            id: UUID::new_v4(),
            name: Some(name.to_string()),
            agent_id,
            message_server_id: None,
            metadata: None,
        }
    }
}

/// Channel type enumeration
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ChannelType {
    /// Messages to self
    #[serde(rename = "SELF")]
    SelfChannel,
    /// Direct messages between two participants
    #[default]
    Dm,
    /// Group messages with multiple participants
    Group,
    /// Voice direct messages
    VoiceDm,
    /// Voice channels with multiple participants
    VoiceGroup,
    /// Social media feed
    Feed,
    /// Threaded conversation
    Thread,
    /// World channel
    World,
    /// Forum discussion
    Forum,
    /// API-initiated messages
    Api,
}

impl ChannelType {
    /// Convert to string representation for database storage
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SelfChannel => "SELF",
            Self::Dm => "DM",
            Self::Group => "GROUP",
            Self::VoiceDm => "VOICE_DM",
            Self::VoiceGroup => "VOICE_GROUP",
            Self::Feed => "FEED",
            Self::Thread => "THREAD",
            Self::World => "WORLD",
            Self::Forum => "FORUM",
            Self::Api => "API",
        }
    }
}

/// Represents a room/channel
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    /// Unique identifier
    pub id: UUID,
    /// Room name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Agent ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    /// Source platform
    pub source: String,
    /// Channel type
    #[serde(rename = "type")]
    pub room_type: ChannelType,
    /// External channel ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Message server ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_server_id: Option<UUID>,
    /// World ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// Room metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
}

impl Room {
    /// Create a new room
    pub fn new(name: &str, source: &str, room_type: ChannelType) -> Self {
        Room {
            id: UUID::new_v4(),
            name: Some(name.to_string()),
            agent_id: None,
            source: source.to_string(),
            room_type,
            channel_id: None,
            message_server_id: None,
            world_id: None,
            metadata: None,
        }
    }
}

/// Room participant with account details
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    /// Unique identifier
    pub id: UUID,
    /// Associated entity
    pub entity: Entity,
}

/// Represents a relationship between entities
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    /// Unique identifier
    pub id: UUID,
    /// Source entity ID
    pub source_entity_id: UUID,
    /// Target entity ID
    pub target_entity_id: UUID,
    /// Agent ID
    pub agent_id: UUID,
    /// Tags for filtering/categorizing
    pub tags: Vec<String>,
    /// Additional metadata
    pub metadata: Metadata,
    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

impl Relationship {
    /// Create a new relationship
    pub fn new(source_entity_id: UUID, target_entity_id: UUID, agent_id: UUID) -> Self {
        Relationship {
            id: UUID::new_v4(),
            source_entity_id,
            target_entity_id,
            agent_id,
            tags: vec![],
            metadata: HashMap::new(),
            created_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_channel_type_serialization() {
        let dm = ChannelType::Dm;
        let json = serde_json::to_string(&dm).unwrap();
        assert_eq!(json, "\"DM\"");

        let group = ChannelType::Group;
        let json = serde_json::to_string(&group).unwrap();
        assert_eq!(json, "\"GROUP\"");
    }

    #[test]
    fn test_room_serialization() {
        let room = Room::new("test-room", "discord", ChannelType::Group);
        let json = serde_json::to_string(&room).unwrap();

        assert!(json.contains("\"name\":\"test-room\""));
        assert!(json.contains("\"source\":\"discord\""));
        assert!(json.contains("\"type\":\"GROUP\""));
    }

    #[test]
    fn test_entity_creation() {
        let entity = Entity::new("TestUser", UUID::new_v4());
        assert_eq!(entity.names[0], "TestUser");
        assert!(entity.id.is_some());
    }
}
