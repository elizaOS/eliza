#![allow(missing_docs)]
//! Pairing request schema for elizaOS database
//!
//! Corresponds to the TypeScript pairingRequestTable in packages/plugin-sql/typescript/schema/pairingRequest.ts

/// SQL for creating the pairing_requests table
pub const CREATE_PAIRING_REQUESTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS pairing_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    code TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB DEFAULT '{}'::jsonb,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE
)
"#;

/// SQL for creating indexes on pairing_requests table
pub const CREATE_PAIRING_REQUESTS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS pairing_requests_channel_agent_idx ON pairing_requests (channel, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS pairing_requests_code_channel_agent_idx ON pairing_requests (code, channel, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS pairing_requests_sender_channel_agent_idx ON pairing_requests (sender_id, channel, agent_id);
"#;

/// Pairing request record structure for database operations
#[derive(Clone, Debug)]
pub struct PairingRequestRecord {
    pub id: uuid::Uuid,
    pub channel: String,
    pub sender_id: String,
    pub code: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_seen_at: chrono::DateTime<chrono::Utc>,
    pub metadata: Option<serde_json::Value>,
    pub agent_id: uuid::Uuid,
}
