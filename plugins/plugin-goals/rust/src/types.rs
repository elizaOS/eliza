//! Type definitions for the Goals plugin
//!
//! Strong types with validation - no unknown or any types.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Goal status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalStatus {
    /// Goal is pending
    Pending,
    /// Goal is in progress
    InProgress,
    /// Goal is completed
    Completed,
    /// Goal is cancelled
    Cancelled,
}

impl fmt::Display for GoalStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        };
        write!(f, "{}", s)
    }
}

impl Default for GoalStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// Goal owner type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GoalOwnerType {
    /// Owned by an agent
    Agent,
    /// Owned by an entity (user)
    Entity,
}

impl fmt::Display for GoalOwnerType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Agent => "agent",
            Self::Entity => "entity",
        };
        write!(f, "{}", s)
    }
}

impl Default for GoalOwnerType {
    fn default() -> Self {
        Self::Entity
    }
}

/// Goal data structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    /// Unique goal ID
    pub id: String,
    /// Agent ID
    pub agent_id: String,
    /// Owner type
    pub owner_type: GoalOwnerType,
    /// Owner ID
    pub owner_id: String,
    /// Goal name
    pub name: String,
    /// Goal description
    pub description: Option<String>,
    /// Whether goal is completed
    pub is_completed: bool,
    /// When goal was completed
    pub completed_at: Option<DateTime<Utc>>,
    /// When goal was created
    pub created_at: DateTime<Utc>,
    /// When goal was last updated
    pub updated_at: DateTime<Utc>,
    /// Additional metadata
    pub metadata: HashMap<String, serde_json::Value>,
    /// Goal tags
    pub tags: Vec<String>,
}

impl Goal {
    /// Check if goal is active (not completed or cancelled)
    pub fn is_active(&self) -> bool {
        !self.is_completed
    }

    /// Get goal status based on completion state
    pub fn status(&self) -> GoalStatus {
        if self.is_completed {
            GoalStatus::Completed
        } else {
            GoalStatus::Pending
        }
    }
}

/// Goal tag structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalTag {
    /// Tag ID
    pub id: String,
    /// Goal ID
    pub goal_id: String,
    /// Tag value
    pub tag: String,
    /// When tag was created
    pub created_at: DateTime<Utc>,
}

/// Parameters for creating a goal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGoalParams {
    /// Agent ID
    pub agent_id: String,
    /// Owner type
    pub owner_type: GoalOwnerType,
    /// Owner ID
    pub owner_id: String,
    /// Goal name
    pub name: String,
    /// Goal description
    pub description: Option<String>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
    /// Goal tags
    #[serde(default)]
    pub tags: Vec<String>,
}

impl CreateGoalParams {
    /// Create new params with required fields
    pub fn new(agent_id: String, owner_type: GoalOwnerType, owner_id: String, name: String) -> Self {
        Self {
            agent_id,
            owner_type,
            owner_id,
            name,
            description: None,
            metadata: HashMap::new(),
            tags: Vec::new(),
        }
    }

    /// Set description (builder pattern)
    pub fn with_description(mut self, description: String) -> Self {
        self.description = Some(description);
        self
    }

    /// Set tags (builder pattern)
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = tags;
        self
    }

    /// Add metadata (builder pattern)
    pub fn with_metadata(mut self, key: String, value: serde_json::Value) -> Self {
        self.metadata.insert(key, value);
        self
    }
}

/// Parameters for updating a goal
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateGoalParams {
    /// New name
    pub name: Option<String>,
    /// New description
    pub description: Option<String>,
    /// Completion status
    pub is_completed: Option<bool>,
    /// Completion time
    pub completed_at: Option<DateTime<Utc>>,
    /// New metadata
    pub metadata: Option<HashMap<String, serde_json::Value>>,
    /// New tags
    pub tags: Option<Vec<String>>,
}

impl UpdateGoalParams {
    /// Create empty update params
    pub fn new() -> Self {
        Self::default()
    }

    /// Set name (builder pattern)
    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }

    /// Set description (builder pattern)
    pub fn with_description(mut self, description: String) -> Self {
        self.description = Some(description);
        self
    }

    /// Set completed (builder pattern)
    pub fn with_completed(mut self, completed: bool) -> Self {
        self.is_completed = Some(completed);
        if completed {
            self.completed_at = Some(Utc::now());
        }
        self
    }

    /// Set tags (builder pattern)
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = Some(tags);
        self
    }
}

/// Filters for querying goals
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GoalFilters {
    /// Filter by owner type
    pub owner_type: Option<GoalOwnerType>,
    /// Filter by owner ID
    pub owner_id: Option<String>,
    /// Filter by completion status
    pub is_completed: Option<bool>,
    /// Filter by tags
    pub tags: Option<Vec<String>>,
}

impl GoalFilters {
    /// Create empty filters
    pub fn new() -> Self {
        Self::default()
    }

    /// Filter by owner type (builder pattern)
    pub fn with_owner_type(mut self, owner_type: GoalOwnerType) -> Self {
        self.owner_type = Some(owner_type);
        self
    }

    /// Filter by owner ID (builder pattern)
    pub fn with_owner_id(mut self, owner_id: String) -> Self {
        self.owner_id = Some(owner_id);
        self
    }

    /// Filter by completion status (builder pattern)
    pub fn with_completed(mut self, completed: bool) -> Self {
        self.is_completed = Some(completed);
        self
    }

    /// Filter by tags (builder pattern)
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = Some(tags);
        self
    }
}

/// Extracted goal information from user message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedGoalInfo {
    /// Goal name
    pub name: String,
    /// Goal description
    pub description: Option<String>,
    /// Owner type
    #[serde(default)]
    pub owner_type: GoalOwnerType,
}

/// Result of checking goal similarity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimilarityCheckResult {
    /// Whether a similar goal exists
    pub has_similar: bool,
    /// Name of similar goal
    pub similar_goal_name: Option<String>,
    /// Confidence level (0-100)
    pub confidence: u8,
}

/// Result of goal selection extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalSelectionResult {
    /// Selected goal ID
    pub goal_id: Option<String>,
    /// Selected goal name
    pub goal_name: Option<String>,
    /// Whether a goal was found
    pub is_found: bool,
}

/// Result of confirmation intent extraction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmationResult {
    /// Whether this is a confirmation
    pub is_confirmation: bool,
    /// Whether to proceed
    pub should_proceed: bool,
    /// Any modifications requested
    pub modifications: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_goal_status_display() {
        assert_eq!(GoalStatus::Pending.to_string(), "pending");
        assert_eq!(GoalStatus::Completed.to_string(), "completed");
    }

    #[test]
    fn test_goal_owner_type_display() {
        assert_eq!(GoalOwnerType::Agent.to_string(), "agent");
        assert_eq!(GoalOwnerType::Entity.to_string(), "entity");
    }

    #[test]
    fn test_create_goal_params_builder() {
        let params = CreateGoalParams::new(
            "agent-123".to_string(),
            GoalOwnerType::Entity,
            "user-456".to_string(),
            "Learn Rust".to_string(),
        )
        .with_description("Master the Rust programming language".to_string())
        .with_tags(vec!["learning".to_string(), "programming".to_string()]);

        assert_eq!(params.name, "Learn Rust");
        assert!(params.description.is_some());
        assert_eq!(params.tags.len(), 2);
    }

    #[test]
    fn test_update_goal_params_builder() {
        let params = UpdateGoalParams::new()
            .with_name("Updated Goal".to_string())
            .with_completed(true);

        assert_eq!(params.name, Some("Updated Goal".to_string()));
        assert_eq!(params.is_completed, Some(true));
        assert!(params.completed_at.is_some());
    }

    #[test]
    fn test_goal_filters_builder() {
        let filters = GoalFilters::new()
            .with_owner_type(GoalOwnerType::Entity)
            .with_completed(false);

        assert_eq!(filters.owner_type, Some(GoalOwnerType::Entity));
        assert_eq!(filters.is_completed, Some(false));
    }
}
