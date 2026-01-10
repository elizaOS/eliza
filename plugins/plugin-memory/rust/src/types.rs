//! Type definitions for the Memory Plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Categories of long-term memory based on cognitive science.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LongTermMemoryCategory {
    /// Specific events, experiences, and interactions
    Episodic,
    /// General facts, concepts, and knowledge
    Semantic,
    /// Skills, workflows, and how-to knowledge
    Procedural,
}

impl std::fmt::Display for LongTermMemoryCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Episodic => write!(f, "episodic"),
            Self::Semantic => write!(f, "semantic"),
            Self::Procedural => write!(f, "procedural"),
        }
    }
}

impl std::str::FromStr for LongTermMemoryCategory {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "episodic" => Ok(Self::Episodic),
            "semantic" => Ok(Self::Semantic),
            "procedural" => Ok(Self::Procedural),
            _ => Err(format!("Invalid memory category: {}", s)),
        }
    }
}

/// Long-term memory entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongTermMemory {
    /// Unique identifier
    pub id: Uuid,
    /// Agent that owns this memory
    pub agent_id: Uuid,
    /// Entity this memory is about
    pub entity_id: Uuid,
    /// Memory category
    pub category: LongTermMemoryCategory,
    /// Memory content
    pub content: String,
    /// Additional metadata
    #[serde(default)]
    pub metadata: serde_json::Value,
    /// Vector embedding for semantic search
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// Confidence score (0-1)
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    /// Source of this memory
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    /// Last access timestamp
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_accessed_at: Option<DateTime<Utc>>,
    /// Access count
    #[serde(default)]
    pub access_count: i32,
    /// Similarity score (from vector search)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f64>,
}

fn default_confidence() -> f64 {
    1.0
}

/// Short-term memory session summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    /// Unique identifier
    pub id: Uuid,
    /// Agent that owns this summary
    pub agent_id: Uuid,
    /// Room this summary is for
    pub room_id: Uuid,
    /// Entity involved in the session
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<Uuid>,
    /// Summary text
    pub summary: String,
    /// Number of messages summarized
    pub message_count: i32,
    /// Offset of last summarized message
    #[serde(default)]
    pub last_message_offset: i32,
    /// Start time of the session
    pub start_time: DateTime<Utc>,
    /// End time of the session
    pub end_time: DateTime<Utc>,
    /// Topics discussed
    #[serde(default)]
    pub topics: Vec<String>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: serde_json::Value,
    /// Vector embedding of the summary
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
}

/// Memory extraction result from evaluator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtraction {
    /// Memory category
    pub category: LongTermMemoryCategory,
    /// Extracted content
    pub content: String,
    /// Confidence score
    pub confidence: f64,
    /// Additional metadata
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// Summary generation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryResult {
    /// Summary text
    pub summary: String,
    /// Topics discussed
    pub topics: Vec<String>,
    /// Key points extracted
    pub key_points: Vec<String>,
}

