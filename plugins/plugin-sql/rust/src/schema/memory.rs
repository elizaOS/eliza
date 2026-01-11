#![allow(missing_docs)]
//! Memory schema for elizaOS database
//!
//! Corresponds to the TypeScript memoryTable in packages/plugin-sql/typescript/schema/memory.ts

/// SQL for creating the memories table
pub const CREATE_MEMORIES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    content JSONB NOT NULL,
    entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE NOT NULL,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    world_id UUID,
    "unique" BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB NOT NULL DEFAULT '{}'
)
"#;

/// SQL for creating indexes on memories table
pub const CREATE_MEMORIES_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_memories_type_room ON memories (type, room_id);
CREATE INDEX IF NOT EXISTS idx_memories_world_id ON memories (world_id);
CREATE INDEX IF NOT EXISTS idx_memories_metadata_type ON memories ((metadata->>'type'));
CREATE INDEX IF NOT EXISTS idx_memories_document_id ON memories ((metadata->>'documentId'));
CREATE INDEX IF NOT EXISTS idx_fragments_order ON memories ((metadata->>'documentId'), (metadata->>'position'));
"#;

/// SQL for memory constraints
pub const CREATE_MEMORIES_CONSTRAINTS: &str = r#"
ALTER TABLE memories 
ADD CONSTRAINT IF NOT EXISTS fragment_metadata_check CHECK (
    CASE 
        WHEN metadata->>'type' = 'fragment' THEN
            metadata ? 'documentId' AND 
            metadata ? 'position'
        ELSE true
    END
);

ALTER TABLE memories 
ADD CONSTRAINT IF NOT EXISTS document_metadata_check CHECK (
    CASE 
        WHEN metadata->>'type' = 'document' THEN
            metadata ? 'timestamp'
        ELSE true
    END
);
"#;

/// Memory record structure for database operations
#[derive(Clone, Debug)]
pub struct MemoryRecord {
    pub id: uuid::Uuid,
    pub memory_type: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub content: serde_json::Value,
    pub entity_id: Option<uuid::Uuid>,
    pub agent_id: uuid::Uuid,
    pub room_id: Option<uuid::Uuid>,
    pub world_id: Option<uuid::Uuid>,
    pub unique: bool,
    pub metadata: serde_json::Value,
}

impl MemoryRecord {
    /// Convert to elizaOS Memory type
    pub fn to_memory(&self) -> elizaos::Memory {
        use elizaos::{Content, Memory, MemoryMetadata, UUID};

        let content: Content = serde_json::from_value(self.content.clone()).unwrap_or_default();

        let metadata: Option<MemoryMetadata> =
            if self.metadata.is_object() && !self.metadata.as_object().unwrap().is_empty() {
                serde_json::from_value(self.metadata.clone()).ok()
            } else {
                None
            };

        Memory {
            id: Some(UUID::new(&self.id.to_string()).unwrap()),
            entity_id: UUID::new(&self.entity_id.map(|u| u.to_string()).unwrap_or_default())
                .unwrap_or_else(|_| UUID::new_v4()),
            agent_id: Some(UUID::new(&self.agent_id.to_string()).unwrap()),
            created_at: Some(self.created_at.timestamp_millis()),
            content,
            embedding: None, // Loaded from embeddings table
            room_id: UUID::new(&self.room_id.map(|u| u.to_string()).unwrap_or_default())
                .unwrap_or_else(|_| UUID::new_v4()),
            world_id: self.world_id.map(|u| UUID::new(&u.to_string()).unwrap()),
            unique: Some(self.unique),
            similarity: None,
            metadata,
        }
    }

    /// Convert from elizaOS Memory type
    pub fn from_memory(memory: &elizaos::Memory, table_name: &str) -> Self {
        MemoryRecord {
            id: memory
                .id
                .as_ref()
                .map(|u| uuid::Uuid::parse_str(u.as_str()).unwrap())
                .unwrap_or_else(uuid::Uuid::new_v4),
            memory_type: table_name.to_string(),
            created_at: memory
                .created_at
                .map(|ts| chrono::DateTime::from_timestamp_millis(ts).unwrap())
                .unwrap_or_else(chrono::Utc::now),
            content: serde_json::to_value(&memory.content).unwrap_or_default(),
            entity_id: Some(uuid::Uuid::parse_str(memory.entity_id.as_str()).unwrap()),
            agent_id: memory
                .agent_id
                .as_ref()
                .map(|u| uuid::Uuid::parse_str(u.as_str()).unwrap())
                .unwrap_or_else(uuid::Uuid::new_v4),
            room_id: Some(uuid::Uuid::parse_str(memory.room_id.as_str()).unwrap()),
            world_id: memory
                .world_id
                .as_ref()
                .map(|u| uuid::Uuid::parse_str(u.as_str()).unwrap()),
            unique: memory.unique.unwrap_or(true),
            metadata: serde_json::to_value(&memory.metadata).unwrap_or_default(),
        }
    }
}
