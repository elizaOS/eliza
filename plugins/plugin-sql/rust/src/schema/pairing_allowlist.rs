#![allow(missing_docs)]
//! Pairing allowlist schema for elizaOS database
//!
//! Corresponds to the TypeScript pairingAllowlistTable in packages/plugin-sql/typescript/schema/pairingAllowlist.ts

/// SQL for creating the pairing_allowlist table
pub const CREATE_PAIRING_ALLOWLIST_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS pairing_allowlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB DEFAULT '{}'::jsonb,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE
)
"#;

/// SQL for creating indexes on pairing_allowlist table
pub const CREATE_PAIRING_ALLOWLIST_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS pairing_allowlist_channel_agent_idx ON pairing_allowlist (channel, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS pairing_allowlist_sender_channel_agent_idx ON pairing_allowlist (sender_id, channel, agent_id);
"#;

/// Pairing allowlist record structure for database operations
#[derive(Clone, Debug)]
pub struct PairingAllowlistRecord {
    pub id: uuid::Uuid,
    pub channel: String,
    pub sender_id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub metadata: Option<serde_json::Value>,
    pub agent_id: uuid::Uuid,
}
