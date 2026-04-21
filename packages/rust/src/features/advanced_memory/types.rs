use crate::types::UUID;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LongTermMemoryCategory {
    #[serde(rename = "episodic")]
    Episodic,
    #[serde(rename = "semantic")]
    Semantic,
    #[serde(rename = "procedural")]
    Procedural,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongTermMemory {
    pub id: UUID,
    pub agent_id: UUID,
    pub entity_id: UUID,
    pub category: LongTermMemoryCategory,
    pub content: String,
    #[serde(default)]
    pub metadata: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
    #[serde(default)]
    pub confidence: Option<f32>,
    #[serde(default)]
    pub source: Option<String>,
    pub created_at: i64, // Unix timestamp
    pub updated_at: i64, // Unix timestamp
    #[serde(default)]
    pub last_accessed_at: Option<i64>,
    #[serde(default)]
    pub access_count: Option<i32>,
    #[serde(default)]
    pub similarity: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: UUID,
    pub agent_id: UUID,
    pub room_id: UUID,
    #[serde(default)]
    pub entity_id: Option<UUID>,
    pub summary: String,
    pub message_count: i32,
    pub last_message_offset: i32,
    pub start_time: i64,
    pub end_time: i64,
    #[serde(default)]
    pub topics: Option<Vec<String>>,
    #[serde(default)]
    pub metadata: Option<serde_json::Map<String, Value>>,
    #[serde(default)]
    pub embedding: Option<Vec<f32>>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    pub short_term_summarization_threshold: i32,
    pub short_term_retain_recent: i32,
    pub short_term_summarization_interval: i32,
    pub long_term_extraction_enabled: bool,
    pub long_term_vector_search_enabled: bool,
    pub long_term_confidence_threshold: f32,
    pub long_term_extraction_threshold: i32,
    pub long_term_extraction_interval: i32,
    #[serde(default)]
    pub summary_model_type: Option<String>,
    #[serde(default)]
    pub summary_max_tokens: Option<i32>,
    #[serde(default)]
    pub summary_max_new_messages: Option<i32>,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            short_term_summarization_threshold: 16,
            short_term_retain_recent: 6,
            short_term_summarization_interval: 10,
            long_term_extraction_enabled: true,
            long_term_vector_search_enabled: false,
            long_term_confidence_threshold: 0.85,
            long_term_extraction_threshold: 30,
            long_term_extraction_interval: 10,
            summary_model_type: Some("TEXT_LARGE".to_string()),
            summary_max_tokens: Some(2500),
            summary_max_new_messages: Some(20),
        }
    }
}

/// Result from LLM summarization (XML parsed)
#[derive(Debug, Clone)]
pub struct SummaryResult {
    pub summary: String,
    pub topics: Vec<String>,
    pub key_points: Vec<String>,
}

/// Result from LLM long-term memory extraction (XML parsed)
#[derive(Debug, Clone)]
pub struct MemoryExtraction {
    pub category: LongTermMemoryCategory,
    pub content: String,
    pub confidence: f32,
}
