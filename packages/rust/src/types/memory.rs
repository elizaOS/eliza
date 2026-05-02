//! Memory types (Rust-native)

use serde::{Deserialize, Serialize};

use super::primitives::{Content, UUID};

/// Memory metadata payload.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MemoryMetadata {
    /// Custom metadata payload (JSON value).
    Custom(serde_json::Value),
}

/// Represents a stored memory/message.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    /// Optional unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Associated entity ID
    pub entity_id: UUID,
    /// Associated agent ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    /// Optional creation timestamp in milliseconds since epoch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Memory content
    pub content: Content,
    /// Optional embedding vector for semantic search
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// Associated room ID
    pub room_id: UUID,
    /// Associated world ID (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// Whether memory is unique (used to prevent duplicates)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    /// Embedding similarity score (set when retrieved via search)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f32>,
    /// Metadata for the memory
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MemoryMetadata>,
}

impl Default for Memory {
    fn default() -> Self {
        Memory {
            id: None,
            entity_id: UUID::default_uuid(),
            agent_id: None,
            created_at: None,
            content: Content::default(),
            embedding: None,
            room_id: UUID::default_uuid(),
            world_id: None,
            unique: None,
            similarity: None,
            metadata: None,
        }
    }
}

impl Memory {
    /// Create a new memory with the given content.
    pub fn new(entity_id: UUID, room_id: UUID, content: Content) -> Self {
        Memory {
            id: Some(UUID::new_v4()),
            entity_id,
            agent_id: None,
            created_at: Some(current_time_ms()),
            content,
            embedding: None,
            room_id,
            world_id: None,
            unique: Some(true),
            similarity: None,
            metadata: None,
        }
    }

    /// Create a message memory with text content.
    pub fn message(entity_id: UUID, room_id: UUID, text: &str) -> Self {
        let content = Content {
            text: Some(text.to_string()),
            ..Default::default()
        };
        Self::new(entity_id, room_id, content)
    }
}

/// Specialized memory alias for messages.
pub type MessageMemory = Memory;

/// Memory type enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MemoryType {
    /// A message in a conversation
    Message,
    /// An action taken by the agent
    Action,
    /// A fact about an entity
    Fact,
    /// Knowledge from the knowledge base
    Knowledge,
}

fn current_time_ms() -> i64 {
    let now = std::time::SystemTime::now();
    let duration = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    duration.as_millis() as i64
}
