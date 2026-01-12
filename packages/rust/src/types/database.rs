//! Database types for elizaOS
//!
//! Contains database-related types, log types, and query parameters.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::memory::MemoryMetadata;
use super::primitives::UUID;

/// Base log body type with common properties
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseLogBody {
    /// Run ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Message ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<UUID>,
    /// Room ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// Entity ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<UUID>,
    /// Additional metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
    /// Extra fields
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Log body for action logs
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLogBody {
    /// Base fields
    #[serde(flatten)]
    pub base: BaseLogBody,
    /// Action name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// Action ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    /// Message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// State snapshot
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
    /// Responses
    #[serde(skip_serializing_if = "Option::is_none")]
    pub responses: Option<serde_json::Value>,
    /// Content with actions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<ActionLogContent>,
    /// Result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ActionLogResult>,
    /// Prompts used
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompts: Option<Vec<PromptLogEntry>>,
    /// Prompt count
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_count: Option<i32>,
    /// Plan step
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_step: Option<String>,
    /// Plan thought
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_thought: Option<String>,
}

/// Action log content
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLogContent {
    /// Actions
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<String>>,
    /// Extra fields
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Action log result
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLogResult {
    /// Success flag
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    /// Data payload
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Text result
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Error message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Extra fields
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Prompt log entry
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptLogEntry {
    /// Model type
    pub model_type: String,
    /// Prompt text
    pub prompt: String,
    /// Timestamp
    pub timestamp: i64,
}

/// Log body for evaluator logs
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatorLogBody {
    /// Base fields
    #[serde(flatten)]
    pub base: BaseLogBody,
    /// Evaluator name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluator: Option<String>,
    /// Message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// State snapshot
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
}

/// Log body for model logs
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLogBody {
    /// Base fields
    #[serde(flatten)]
    pub base: BaseLogBody,
    /// Model type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    /// Model key
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_key: Option<String>,
    /// Parameters
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<HashMap<String, serde_json::Value>>,
    /// Prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// System prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    /// Execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_time: Option<i64>,
    /// Provider
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Action context
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_context: Option<ModelActionContext>,
    /// Response
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<serde_json::Value>,
}

/// Model action context
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelActionContext {
    /// Action name
    pub action_name: String,
    /// Action ID
    pub action_id: UUID,
}

/// Log body for embedding logs
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingLogBody {
    /// Base fields
    #[serde(flatten)]
    pub base: BaseLogBody,
    /// Memory ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    /// Duration in ms
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<i64>,
}

/// Union type for log body
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LogBody {
    /// Base log
    Base(BaseLogBody),
    /// Action log
    Action(ActionLogBody),
    /// Evaluator log
    Evaluator(EvaluatorLogBody),
    /// Model log
    Model(ModelLogBody),
    /// Embedding log
    Embedding(EmbeddingLogBody),
}

/// Represents a log entry
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    /// Optional unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Associated entity ID
    pub entity_id: UUID,
    /// Associated room ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// Log body
    pub body: LogBody,
    /// Log type
    #[serde(rename = "type")]
    pub log_type: String,
    /// Log creation timestamp
    pub created_at: String,
}

/// Run status for agent runs
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    /// Run started
    Started,
    /// Run completed
    Completed,
    /// Run timed out
    Timeout,
    /// Run errored
    Error,
}

/// Agent run counts
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunCounts {
    /// Number of actions
    pub actions: i32,
    /// Number of model calls
    pub model_calls: i32,
    /// Number of errors
    pub errors: i32,
    /// Number of evaluators
    pub evaluators: i32,
}

/// Agent run summary
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSummary {
    /// Run ID
    pub run_id: String,
    /// Status
    pub status: RunStatus,
    /// Start time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// End time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Duration in ms
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    /// Message ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<UUID>,
    /// Room ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// Entity ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<UUID>,
    /// Metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
    /// Counts
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<AgentRunCounts>,
}

/// Result for agent run summaries query
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunSummaryResult {
    /// Run summaries
    pub runs: Vec<AgentRunSummary>,
    /// Total count
    pub total: i32,
    /// Whether there are more results
    pub has_more: bool,
}

/// Parameters for getting memories
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMemoriesParams {
    /// Entity ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<UUID>,
    /// Agent ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    /// Number of results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i32>,
    /// Offset for pagination
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    /// Only unique memories
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    /// Table name
    pub table_name: String,
    /// Start timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    /// End timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    /// Room ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// World ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
}

/// Parameters for searching memories
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMemoriesParams {
    /// Embedding vector
    pub embedding: Vec<f32>,
    /// Match threshold
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_threshold: Option<f64>,
    /// Number of results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i32>,
    /// Only unique memories
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    /// Table name
    pub table_name: String,
    /// Query string
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// Room ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// World ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// Entity ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<UUID>,
}

/// Result for embedding similarity searches
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingSearchResult {
    /// Embedding vector
    pub embedding: Vec<f32>,
    /// Levenshtein score
    pub levenshtein_score: f64,
}

/// Options for memory retrieval
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRetrievalOptions {
    /// Room ID
    pub room_id: UUID,
    /// Number of results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i32>,
    /// Only unique
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    /// Start timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    /// End timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    /// Agent ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
}

/// Options for memory search
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchOptions {
    /// Embedding vector
    pub embedding: Vec<f32>,
    /// Match threshold
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_threshold: Option<f64>,
    /// Number of results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i32>,
    /// Room ID
    pub room_id: UUID,
    /// Agent ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<UUID>,
    /// Only unique
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    /// Metadata filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MemoryMetadata>,
}

/// Allowed vector dimensions
pub mod vector_dims {
    /// 384 dimensions
    pub const SMALL: usize = 384;
    /// 512 dimensions
    pub const MEDIUM: usize = 512;
    /// 768 dimensions
    pub const LARGE: usize = 768;
    /// 1024 dimensions
    pub const XL: usize = 1024;
    /// 1536 dimensions
    pub const XXL: usize = 1536;
    /// 3072 dimensions
    pub const XXXL: usize = 3072;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_status_serialization() {
        let status = RunStatus::Completed;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"completed\"");
    }

    #[test]
    fn test_get_memories_params_serialization() {
        let params = GetMemoriesParams {
            table_name: "messages".to_string(),
            count: Some(10),
            ..Default::default()
        };

        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"tableName\":\"messages\""));
        assert!(json.contains("\"count\":10"));
    }
}
