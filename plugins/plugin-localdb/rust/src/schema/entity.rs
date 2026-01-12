#![allow(missing_docs)]

pub const CREATE_ENTITIES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    names JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE NOT NULL
)
"#;

pub const CREATE_ENTITIES_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON entities (agent_id);
"#;

/// Entity record structure
#[derive(Clone, Debug)]
pub struct EntityRecord {
    pub id: uuid::Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub names: serde_json::Value,
    pub metadata: serde_json::Value,
    pub agent_id: uuid::Uuid,
}

impl EntityRecord {
    pub fn to_entity(&self) -> elizaos::Entity {
        use elizaos::{Entity, UUID};

        let names: Vec<String> = serde_json::from_value(self.names.clone()).unwrap_or_default();

        let metadata: std::collections::HashMap<String, serde_json::Value> =
            serde_json::from_value(self.metadata.clone()).unwrap_or_default();

        Entity {
            id: Some(UUID::new(&self.id.to_string()).unwrap()),
            names,
            metadata,
            agent_id: UUID::new(&self.agent_id.to_string()).unwrap(),
            components: None,
        }
    }
}
