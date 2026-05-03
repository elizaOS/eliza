#![allow(missing_docs)]
//! Central message schema for elizaOS database
//!
//! Corresponds to the TypeScript messageTable in packages/plugin-sql/typescript/schema/message.ts

/// SQL for creating the central_messages table
pub const CREATE_CENTRAL_MESSAGES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS central_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    raw_message JSONB,
    in_reply_to_root_message_id TEXT REFERENCES central_messages(id) ON DELETE SET NULL,
    source_type TEXT,
    source_id TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"#;

/// Central message record structure for database operations
#[derive(Clone, Debug)]
pub struct CentralMessageRecord {
    pub id: String,
    pub channel_id: String,
    pub author_id: String,
    pub content: String,
    pub raw_message: Option<serde_json::Value>,
    pub in_reply_to_root_message_id: Option<String>,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
