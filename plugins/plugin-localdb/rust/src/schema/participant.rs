#![allow(missing_docs)]

pub const CREATE_PARTICIPANTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID REFERENCES entities(id) ON DELETE CASCADE NOT NULL,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_state TEXT
)
"#;

/// SQL for creating indexes on participants table
pub const CREATE_PARTICIPANTS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_participants_entity_id ON participants (entity_id);
CREATE INDEX IF NOT EXISTS idx_participants_room_id ON participants (room_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_unique ON participants (entity_id, room_id);
"#;

#[derive(Clone, Debug)]
pub struct ParticipantRecord {
    pub id: uuid::Uuid,
    pub entity_id: uuid::Uuid,
    pub room_id: uuid::Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub user_state: Option<String>,
}

impl ParticipantRecord {
    pub fn to_participant_info(&self) -> crate::base::ParticipantInfo {
        use elizaos::UUID;

        crate::base::ParticipantInfo {
            id: UUID::new(&self.id.to_string()).unwrap(),
            entity_id: UUID::new(&self.entity_id.to_string()).unwrap(),
            room_id: UUID::new(&self.room_id.to_string()).unwrap(),
            user_state: self.user_state.clone(),
            created_at: Some(self.created_at.timestamp_millis()),
        }
    }
}
