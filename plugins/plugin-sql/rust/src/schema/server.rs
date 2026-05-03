#![allow(missing_docs)]
//! Server schema for elizaOS database
//!
//! Corresponds to the TypeScript serverTable in packages/plugin-sql/typescript/schema/server.ts

/// SQL for creating the servers table
pub const CREATE_SERVERS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS servers (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"#;

/// Server record structure for database operations
#[derive(Clone, Debug)]
pub struct ServerRecord {
    pub id: uuid::Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
