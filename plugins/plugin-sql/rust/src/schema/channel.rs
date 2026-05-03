#![allow(missing_docs)]
//! Channel schema for elizaOS database
//!
//! Corresponds to the TypeScript channelTable in packages/plugin-sql/typescript/schema/channel.ts

/// SQL for creating the channels table
pub const CREATE_CHANNELS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    message_server_id UUID NOT NULL REFERENCES message_servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    source_type TEXT,
    source_id TEXT,
    topic TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"#;

/// Channel record structure for database operations
#[derive(Clone, Debug)]
pub struct ChannelRecord {
    pub id: String,
    pub message_server_id: uuid::Uuid,
    pub name: String,
    pub channel_type: String,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    pub topic: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
