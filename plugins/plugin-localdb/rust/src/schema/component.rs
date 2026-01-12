#![allow(missing_docs)]

pub const CREATE_COMPONENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE NOT NULL,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE NOT NULL,
    world_id UUID REFERENCES worlds(id) ON DELETE CASCADE NOT NULL,
    source_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    data JSONB NOT NULL DEFAULT '{}'::jsonb
)
"#;

pub const CREATE_COMPONENTS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_components_entity_id ON components (entity_id);
CREATE INDEX IF NOT EXISTS idx_components_type ON components (type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_components_unique ON components (entity_id, type, world_id, source_entity_id);
"#;

#[derive(Clone, Debug)]
pub struct ComponentRecord {
    pub id: uuid::Uuid,
    pub entity_id: uuid::Uuid,
    pub agent_id: uuid::Uuid,
    pub room_id: uuid::Uuid,
    pub world_id: uuid::Uuid,
    pub source_entity_id: uuid::Uuid,
    pub component_type: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub data: serde_json::Value,
}

impl ComponentRecord {
    pub fn to_component(&self) -> elizaos::Component {
        use elizaos::{Component, UUID};

        Component {
            id: UUID::new(&self.id.to_string()).unwrap(),
            entity_id: UUID::new(&self.entity_id.to_string()).unwrap(),
            agent_id: UUID::new(&self.agent_id.to_string()).unwrap(),
            room_id: UUID::new(&self.room_id.to_string()).unwrap(),
            world_id: UUID::new(&self.world_id.to_string()).unwrap(),
            source_entity_id: UUID::new(&self.source_entity_id.to_string()).unwrap(),
            component_type: self.component_type.clone(),
            created_at: self.created_at.timestamp_millis(),
            data: serde_json::from_value(self.data.clone()).unwrap_or_default(),
        }
    }
}
