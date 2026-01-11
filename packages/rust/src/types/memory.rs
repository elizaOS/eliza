//! Memory types for elizaOS
//!
//! Contains Memory, MemoryMetadata, and related types for storing agent memories.

use super::primitives::{Content, UUID};
use serde::{Deserialize, Serialize};

/// Memory type enumeration for built-in memory types
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MemoryType {
    /// Represents a whole document or a large piece of text
    Document,
    /// A chunk or segment of a document
    Fragment,
    /// A conversational message
    #[default]
    Message,
    /// A descriptive piece of information
    Description,
    /// Custom memory type
    Custom,
}

/// Defines the scope of a memory
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MemoryScope {
    /// Accessible to multiple entities
    Shared,
    /// Private to a single entity
    Private,
    /// Scoped to a specific room
    #[default]
    Room,
}

/// Base interface for all memory metadata types
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseMetadata {
    /// The kind of memory
    #[serde(rename = "type")]
    pub memory_type: String,
    /// Source of the memory
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Source entity ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<UUID>,
    /// Visibility scope
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<MemoryScope>,
    /// Timestamp in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    /// Tags for categorization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// Document-specific metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    /// Base metadata fields
    #[serde(flatten)]
    pub base: BaseMetadata,
}

/// Fragment-specific metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentMetadata {
    /// Base metadata fields
    #[serde(flatten)]
    pub base: BaseMetadata,
    /// Parent document ID
    pub document_id: UUID,
    /// Position in document
    pub position: i32,
}

/// Message-specific metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMetadata {
    /// Base metadata fields
    #[serde(flatten)]
    pub base: BaseMetadata,
}

/// Description-specific metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DescriptionMetadata {
    /// Base metadata fields
    #[serde(flatten)]
    pub base: BaseMetadata,
}

/// Union type for all memory metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MemoryMetadata {
    /// Document metadata
    Document(DocumentMetadata),
    /// Fragment metadata
    Fragment(FragmentMetadata),
    /// Message metadata
    Message(MessageMetadata),
    /// Description metadata
    Description(DescriptionMetadata),
    /// Custom metadata (catch-all)
    Custom(serde_json::Value),
}

impl Default for MemoryMetadata {
    fn default() -> Self {
        MemoryMetadata::Custom(serde_json::Value::Object(serde_json::Map::new()))
    }
}

/// Represents a stored memory/message
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    /// Optional unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Associated entity ID (user)
    pub entity_id: UUID,
    /// Associated agent ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    /// Creation timestamp in milliseconds since epoch
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Memory content
    pub content: Content,
    /// Embedding vector for semantic search
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// Associated room ID
    pub room_id: UUID,
    /// Associated world ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// Whether memory is unique (used to prevent duplicates)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    /// Embedding similarity score (set when retrieved via search)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f64>,
    /// Metadata for the memory
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MemoryMetadata>,
}

impl Memory {
    /// Create a new memory with the given content
    pub fn new(entity_id: UUID, room_id: UUID, content: Content) -> Self {
        Memory {
            id: Some(UUID::new_v4()),
            entity_id,
            agent_id: None,
            created_at: Some(chrono_timestamp()),
            content,
            embedding: None,
            room_id,
            world_id: None,
            unique: Some(true),
            similarity: None,
            metadata: None,
        }
    }

    /// Create a message memory
    pub fn message(entity_id: UUID, room_id: UUID, text: &str) -> Self {
        let content = Content {
            text: Some(text.to_string()),
            ..Default::default()
        };
        let mut memory = Memory::new(entity_id, room_id, content);
        memory.metadata = Some(MemoryMetadata::Message(MessageMetadata {
            base: BaseMetadata {
                memory_type: "message".to_string(),
                ..Default::default()
            },
        }));
        memory
    }
}

/// Get current timestamp in milliseconds
fn chrono_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Specialized memory type for messages with enhanced type checking
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMemory {
    /// The underlying memory
    #[serde(flatten)]
    pub memory: Memory,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_serialization() {
        let memory = Memory::message(UUID::new_v4(), UUID::new_v4(), "Hello, world!");

        let json = serde_json::to_string(&memory).unwrap();

        // Should use camelCase
        assert!(json.contains("\"entityId\""));
        assert!(json.contains("\"roomId\""));
        assert!(json.contains("\"createdAt\""));
    }

    #[test]
    fn test_memory_deserialization() {
        let json = r#"{
            "entityId": "550e8400-e29b-41d4-a716-446655440000",
            "roomId": "550e8400-e29b-41d4-a716-446655440001",
            "content": {
                "text": "Hello from TypeScript!"
            }
        }"#;

        let memory: Memory = serde_json::from_str(json).unwrap();
        assert_eq!(memory.content.text.unwrap(), "Hello from TypeScript!");
    }
}
