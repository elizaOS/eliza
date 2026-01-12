#![allow(missing_docs)]

pub const CREATE_LOGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    body JSONB NOT NULL,
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"#;

pub const CREATE_LOGS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_logs_entity_id ON logs (entity_id);
CREATE INDEX IF NOT EXISTS idx_logs_room_id ON logs (room_id);
CREATE INDEX IF NOT EXISTS idx_logs_type ON logs (type);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at);
"#;

/// Log record structure
#[derive(Clone, Debug)]
pub struct LogRecord {
    pub id: uuid::Uuid,
    pub entity_id: uuid::Uuid,
    pub room_id: Option<uuid::Uuid>,
    pub body: serde_json::Value,
    pub log_type: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl LogRecord {
    pub fn to_log(&self) -> elizaos::Log {
        use elizaos::{Log, LogBody, UUID};

        Log {
            id: Some(UUID::new(&self.id.to_string()).unwrap()),
            entity_id: UUID::new(&self.entity_id.to_string()).unwrap(),
            room_id: self.room_id.map(|u| UUID::new(&u.to_string()).unwrap()),
            body: LogBody::Base(serde_json::from_value(self.body.clone()).unwrap_or_default()),
            log_type: self.log_type.clone(),
            created_at: self.created_at.to_rfc3339(),
        }
    }
}
