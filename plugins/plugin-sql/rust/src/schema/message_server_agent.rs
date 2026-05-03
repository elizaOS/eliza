#![allow(missing_docs)]
//! Message server agent schema for elizaOS database
//!
//! Corresponds to the TypeScript messageServerAgentsTable in packages/plugin-sql/typescript/schema/messageServerAgent.ts

/// SQL for creating the message_server_agents table
pub const CREATE_MESSAGE_SERVER_AGENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS message_server_agents (
    message_server_id UUID NOT NULL REFERENCES message_servers(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (message_server_id, agent_id)
)
"#;

/// Message server agent record structure for database operations
#[derive(Clone, Debug)]
pub struct MessageServerAgentRecord {
    pub message_server_id: uuid::Uuid,
    pub agent_id: uuid::Uuid,
}
