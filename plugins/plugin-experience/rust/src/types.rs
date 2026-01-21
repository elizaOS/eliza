use serde::{Deserialize, Serialize};

/// Experience category/type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
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
    #[default]
    Learning,
    /// Agent formed a hypothesis.
    Hypothesis,
    /// Agent validated a hypothesis.
    Validation,
    /// Agent encountered a warning/limitation.
    Warning,
}

/// Outcome of an experience.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum OutcomeType {
    /// Positive outcome.
    Positive,
    /// Negative outcome.
    Negative,
    /// Neutral outcome.
    #[default]
    Neutral,
    /// Mixed outcome.
    Mixed,
}

/// Core experience record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Experience {
    /// Experience id (UUID string).
    pub id: String,
    /// Agent id (UUID string).
    pub agent_id: String,

    /// Experience type.
    #[serde(rename = "type")]
    pub experience_type: ExperienceType,
    /// Experience outcome.
    pub outcome: OutcomeType,

    /// What was happening.
    pub context: String,
    /// What the agent tried to do.
    pub action: String,
    /// What actually happened.
    pub result: String,
    /// What was learned.
    pub learning: String,

    /// Tags for categorization.
    pub tags: Vec<String>,
    /// Domain of experience (e.g. "shell", "coding").
    pub domain: String,

    /// Links to related experiences.
    pub related_experiences: Option<Vec<String>>,
    /// If this experience updates/replaces another.
    pub supersedes: Option<String>,

    /// 0-1 confidence.
    pub confidence: f64,
    /// 0-1 importance.
    pub importance: f64,

    /// Unix ms timestamp when the experience was created.
    pub created_at: i64,
    /// Unix ms timestamp when the experience was last updated.
    pub updated_at: i64,
    /// Unix ms timestamp when the experience was last accessed.
    pub last_accessed_at: Option<i64>,
    /// Number of times the experience has been accessed.
    pub access_count: u32,

    /// For corrections: what the agent believed before.
    pub previous_belief: Option<String>,
    /// For corrections: what the agent now believes.
    pub corrected_belief: Option<String>,

    /// Optional embedding vector.
    pub embedding: Option<Vec<f64>>,
    /// Related memory ids.
    pub memory_ids: Option<Vec<String>>,
}

/// Time window filter for queries (unix ms).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    /// Start of the time range (unix ms, inclusive).
    pub start: Option<i64>,
    /// End of the time range (unix ms, inclusive).
    pub end: Option<i64>,
}

/// Query parameters for retrieving experiences.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperienceQuery {
    /// Free-text query for similarity search.
    pub query: Option<String>,
    /// Filter by experience types.
    pub types: Option<Vec<ExperienceType>>,
    /// Filter by outcome types.
    pub outcomes: Option<Vec<OutcomeType>>,
    /// Filter by domains.
    pub domains: Option<Vec<String>>,
    /// Filter by tags (any match).
    pub tags: Option<Vec<String>>,
    /// Minimum importance threshold (0-1).
    pub min_importance: Option<f64>,
    /// Minimum confidence threshold (0-1).
    pub min_confidence: Option<f64>,
    /// Time range filter.
    pub time_range: Option<TimeRange>,
    /// Maximum number of results to return.
    pub limit: Option<usize>,
    /// Whether to include related experiences in results.
    pub include_related: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_experience_type_serde() {
        let json = serde_json::to_string(&ExperienceType::Discovery).unwrap();
        assert_eq!(json, "\"discovery\"");
    }
}
