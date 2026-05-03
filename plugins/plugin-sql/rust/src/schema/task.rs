#![allow(missing_docs)]
//! Task schema for elizaOS database

/// SQL for creating the tasks table
pub const CREATE_TASKS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    world_id UUID REFERENCES worlds(id) ON DELETE CASCADE,
    entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
    tags JSONB DEFAULT '[]'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    scheduled_at TIMESTAMPTZ,
    repeat_interval BIGINT,
    data JSONB
)
"#;

/// SQL for creating indexes on tasks table
pub const CREATE_TASKS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_tasks_room_id ON tasks (room_id);
CREATE INDEX IF NOT EXISTS idx_tasks_world_id ON tasks (world_id);
CREATE INDEX IF NOT EXISTS idx_tasks_entity_id ON tasks (entity_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_name ON tasks (name);
"#;

/// Task record structure
#[derive(Clone, Debug)]
pub struct TaskRecord {
    pub id: uuid::Uuid,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub room_id: Option<uuid::Uuid>,
    pub world_id: Option<uuid::Uuid>,
    pub entity_id: Option<uuid::Uuid>,
    pub tags: serde_json::Value,
    pub metadata: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub scheduled_at: Option<chrono::DateTime<chrono::Utc>>,
    pub repeat_interval: Option<i64>,
    pub data: Option<serde_json::Value>,
}

impl TaskRecord {
    /// Convert to elizaOS Task type
    pub fn to_task(&self) -> elizaos::Task {
        use elizaos::{Task, TaskStatus, UUID};

        let status = match self.status.as_str() {
            "pending" => TaskStatus::Pending,
            "in_progress" | "running" => TaskStatus::InProgress,
            "completed" => TaskStatus::Completed,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            _ => TaskStatus::Pending,
        };

        Task {
            id: Some(UUID::new(&self.id.to_string()).unwrap()),
            name: self.name.clone(),
            description: self.description.clone(),
            status: Some(status),
            room_id: self.room_id.map(|u| UUID::new(&u.to_string()).unwrap()),
            world_id: self.world_id.map(|u| UUID::new(&u.to_string()).unwrap()),
            entity_id: self.entity_id.map(|u| UUID::new(&u.to_string()).unwrap()),
            tags: serde_json::from_value(self.tags.clone()).ok(),
            metadata: serde_json::from_value(self.metadata.clone()).ok(),
            created_at: Some(self.created_at.timestamp_millis()),
            updated_at: Some(self.updated_at.timestamp_millis()),
            scheduled_at: self.scheduled_at.map(|dt| dt.timestamp_millis()),
            repeat_interval: self.repeat_interval,
            data: self.data.clone(),
        }
    }
}
