#![allow(missing_docs)]
//! Relationship schema for elizaOS database

/// SQL for creating the relationships table
pub const CREATE_RELATIONSHIPS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    target_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE NOT NULL,
    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"#;

/// SQL for creating indexes on relationships table
pub const CREATE_RELATIONSHIPS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_relationships_source_entity ON relationships (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target_entity ON relationships (target_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_agent_id ON relationships (agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_unique ON relationships (source_entity_id, target_entity_id, agent_id);
"#;

/// Relationship record structure
#[derive(Clone, Debug)]
pub struct RelationshipRecord {
    pub id: uuid::Uuid,
    pub source_entity_id: uuid::Uuid,
    pub target_entity_id: uuid::Uuid,
    pub agent_id: uuid::Uuid,
    pub tags: serde_json::Value,
    pub metadata: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl RelationshipRecord {
    /// Convert to elizaOS Relationship type
    pub fn to_relationship(&self) -> elizaos::Relationship {
        use elizaos::{Relationship, UUID};

        let tags: Vec<String> = serde_json::from_value(self.tags.clone()).unwrap_or_default();

        Relationship {
            id: UUID::new(&self.id.to_string()).unwrap(),
            source_entity_id: UUID::new(&self.source_entity_id.to_string()).unwrap(),
            target_entity_id: UUID::new(&self.target_entity_id.to_string()).unwrap(),
            agent_id: UUID::new(&self.agent_id.to_string()).unwrap(),
            tags: Some(tags),
            metadata: Some(self.metadata.clone()),
        }
    }
}
