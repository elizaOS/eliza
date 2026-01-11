#![allow(missing_docs)]
//! Agent schema for elizaOS database
//!
//! Corresponds to the TypeScript agentTable in packages/plugin-sql/typescript/schema/agent.ts

/// SQL for creating the agents table
pub const CREATE_AGENTS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enabled BOOLEAN NOT NULL DEFAULT true,
    server_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL,
    username TEXT,
    system TEXT DEFAULT '',
    bio JSONB DEFAULT '[]'::jsonb,
    message_examples JSONB DEFAULT '[]'::jsonb NOT NULL,
    post_examples JSONB DEFAULT '[]'::jsonb NOT NULL,
    topics JSONB DEFAULT '[]'::jsonb NOT NULL,
    adjectives JSONB DEFAULT '[]'::jsonb NOT NULL,
    knowledge JSONB DEFAULT '[]'::jsonb NOT NULL,
    plugins JSONB DEFAULT '[]'::jsonb NOT NULL,
    settings JSONB DEFAULT '{}'::jsonb NOT NULL,
    style JSONB DEFAULT '{}'::jsonb NOT NULL
)
"#;

/// SQL for creating indexes on agents table
pub const CREATE_AGENTS_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents (enabled);
CREATE INDEX IF NOT EXISTS idx_agents_server_id ON agents (server_id);
"#;

/// Agent record structure for database operations
#[derive(Clone, Debug)]
pub struct AgentRecord {
    pub id: uuid::Uuid,
    pub enabled: bool,
    pub server_id: Option<uuid::Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub name: String,
    pub username: Option<String>,
    pub system: Option<String>,
    pub bio: serde_json::Value,
    pub message_examples: serde_json::Value,
    pub post_examples: serde_json::Value,
    pub topics: serde_json::Value,
    pub adjectives: serde_json::Value,
    pub knowledge: serde_json::Value,
    pub plugins: serde_json::Value,
    pub settings: serde_json::Value,
    pub style: serde_json::Value,
}

impl AgentRecord {
    /// Convert to elizaOS Agent type
    pub fn to_agent(&self) -> elizaos::Agent {
        use elizaos::{Agent, Bio, Character, UUID};

        let bio = if let Some(arr) = self.bio.as_array() {
            Bio::Multiple(
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect(),
            )
        } else if let Some(s) = self.bio.as_str() {
            Bio::Single(s.to_string())
        } else {
            Bio::Single(String::new())
        };

        let character = Character {
            id: Some(UUID::new(&self.id.to_string()).unwrap()),
            name: self.name.clone(),
            username: self.username.clone(),
            system: self.system.clone(),
            bio,
            message_examples: serde_json::from_value(self.message_examples.clone()).ok(),
            post_examples: serde_json::from_value(self.post_examples.clone()).ok(),
            topics: serde_json::from_value(self.topics.clone()).ok(),
            adjectives: serde_json::from_value(self.adjectives.clone()).ok(),
            knowledge: serde_json::from_value(self.knowledge.clone()).ok(),
            plugins: serde_json::from_value(self.plugins.clone()).ok(),
            settings: serde_json::from_value(self.settings.clone()).ok(),
            style: serde_json::from_value(self.style.clone()).ok(),
            ..Default::default()
        };

        Agent {
            character,
            enabled: Some(self.enabled),
            status: None,
            created_at: self.created_at.timestamp_millis(),
            updated_at: self.updated_at.timestamp_millis(),
        }
    }
}
