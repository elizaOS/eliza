#![allow(missing_docs)]
//! Message server schema for elizaOS database
//!
//! Corresponds to the TypeScript messageServerTable in packages/plugin-sql/typescript/schema/messageServer.ts

/// SQL for creating the message_servers table
pub const CREATE_MESSAGE_SERVERS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS message_servers (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"#;

/// Message server record structure for database operations
#[derive(Clone, Debug)]
pub struct MessageServerRecord {
    pub id: uuid::Uuid,
    pub name: String,
    pub source_type: String,
    pub source_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
