//! Experience types — Rust port of the TypeScript experience types.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The kind of experience the agent had.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ExperienceType {
    /// Agent accomplished something.
    Success,
    /// Agent failed at something.
    Failure,
    /// Agent discovered new information.
    Discovery,
    /// Agent corrected a mistake.
    Correction,
    /// Agent learned something new.
    Learning,
    /// Agent formed a hypothesis.
    Hypothesis,
    /// Agent validated a hypothesis.
    Validation,
    /// Agent encountered a warning / limitation.
    Warning,
}

/// Outcome polarity.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum OutcomeType {
    Positive,
    Negative,
    Neutral,
    Mixed,
}

/// A single experience record.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Experience {
    pub id: Uuid,
    pub agent_id: Uuid,
    #[serde(rename = "type")]
    pub experience_type: ExperienceType,
    pub outcome: OutcomeType,

    // Context and details
    pub context: String,
    pub action: String,
    pub result: String,
    pub learning: String,

    // Categorization
    pub tags: Vec<String>,
    pub domain: String,

    // Related experiences
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub related_experiences: Option<Vec<Uuid>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<Uuid>,

    // Confidence and importance
    pub confidence: f64,
    pub importance: f64,

    // Temporal information
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_accessed_at: Option<i64>,
    pub access_count: u64,

    // For corrections
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_belief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corrected_belief: Option<String>,

    // Memory integration
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_ids: Option<Vec<Uuid>>,
}

/// Time range filter.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
}

/// Query for searching experiences.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub experience_type: Option<Vec<ExperienceType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Vec<OutcomeType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_importance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_range: Option<TimeRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_related: bool,
}

/// Analysis derived from a set of experiences.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceAnalysis {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommendations: Option<Vec<String>>,
}

/// Event emitted when an experience changes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceEvent {
    pub experience_id: Uuid,
    pub event_type: ExperienceEventType,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Kind of experience event.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExperienceEventType {
    Created,
    Accessed,
    Updated,
    Superseded,
}
