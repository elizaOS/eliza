use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// The current status of a goal.
///
/// Goals progress through various states during their lifecycle,
/// from initial creation to completion or cancellation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum GoalStatus {
    /// Goal has been created but work has not yet begun.
    #[default]
    Pending,
    /// Goal is actively being worked on.
    InProgress,
    /// Goal has been successfully completed.
    Completed,
    /// Goal was cancelled before completion.
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

/// The type of entity that owns a goal.
///
/// Goals can be owned by either an agent (AI) or an entity (user/external system).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum GoalOwnerType {
    /// Goal is owned by an AI agent.
    Agent,
    /// Goal is owned by a user or external entity.
    #[default]
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

/// A goal that can be tracked and managed by the system.
///
/// Goals represent objectives or tasks that agents or entities want to accomplish.
/// They support metadata, tags, and completion tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    /// Unique identifier for this goal (UUID format).
    pub id: String,
    /// The ID of the agent associated with this goal.
    pub agent_id: String,
    /// Whether the goal is owned by an agent or entity.
    pub owner_type: GoalOwnerType,
    /// The ID of the owner (agent or entity) of this goal.
    pub owner_id: String,
    /// The name or title of the goal.
    pub name: String,
    /// Optional detailed description of the goal.
    pub description: Option<String>,
    /// Whether the goal has been completed.
    pub is_completed: bool,
    /// Timestamp when the goal was completed, if applicable.
    pub completed_at: Option<DateTime<Utc>>,
    /// Timestamp when the goal was created.
    pub created_at: DateTime<Utc>,
    /// Timestamp when the goal was last updated.
    pub updated_at: DateTime<Utc>,
    /// Arbitrary key-value metadata associated with the goal.
    pub metadata: HashMap<String, serde_json::Value>,
    /// Tags for categorizing and filtering goals.
    pub tags: Vec<String>,
}

impl Goal {
    /// Checks if the goal is currently active (not completed).
    ///
    /// # Returns
    ///
    /// `true` if the goal is not yet completed, `false` otherwise.
    pub fn is_active(&self) -> bool {
        !self.is_completed
    }

    /// Gets the current status of the goal.
    ///
    /// # Returns
    ///
    /// The `GoalStatus` based on the completion state.
    pub fn status(&self) -> GoalStatus {
        if self.is_completed {
            GoalStatus::Completed
        } else {
            GoalStatus::Pending
        }
    }
}

/// A tag associated with a goal for categorization purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalTag {
    /// Unique identifier for this tag association.
    pub id: String,
    /// The ID of the goal this tag belongs to.
    pub goal_id: String,
    /// The tag value/label.
    pub tag: String,
    /// Timestamp when the tag was added.
    pub created_at: DateTime<Utc>,
}

/// Parameters for creating a new goal.
///
/// Use the builder pattern methods to construct a complete set of parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGoalParams {
    /// The ID of the agent associated with this goal.
    pub agent_id: String,
    /// Whether the goal is owned by an agent or entity.
    pub owner_type: GoalOwnerType,
    /// The ID of the owner (agent or entity) of this goal.
    pub owner_id: String,
    /// The name or title of the goal.
    pub name: String,
    /// Optional detailed description of the goal.
    pub description: Option<String>,
    /// Arbitrary key-value metadata to associate with the goal.
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
    /// Tags for categorizing the goal.
    #[serde(default)]
    pub tags: Vec<String>,
}

impl CreateGoalParams {
    /// Creates a new `CreateGoalParams` with required fields.
    ///
    /// # Arguments
    ///
    /// * `agent_id` - The ID of the associated agent
    /// * `owner_type` - Whether owned by agent or entity
    /// * `owner_id` - The ID of the owner
    /// * `name` - The name of the goal
    pub fn new(
        agent_id: String,
        owner_type: GoalOwnerType,
        owner_id: String,
        name: String,
    ) -> Self {
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

    /// Adds a metadata key-value pair (builder pattern).
    ///
    /// Multiple calls will accumulate metadata entries.
    pub fn with_metadata(mut self, key: String, value: serde_json::Value) -> Self {
        self.metadata.insert(key, value);
        self
    }
}

/// Parameters for updating an existing goal.
///
/// All fields are optional; only provided fields will be updated.
/// Use the builder pattern methods to construct the update.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateGoalParams {
    /// New name for the goal, if changing.
    pub name: Option<String>,
    /// New description for the goal, if changing.
    pub description: Option<String>,
    /// New completion status, if changing.
    pub is_completed: Option<bool>,
    /// Timestamp when completed, typically set automatically.
    pub completed_at: Option<DateTime<Utc>>,
    /// New metadata, replaces existing metadata if provided.
    pub metadata: Option<HashMap<String, serde_json::Value>>,
    /// New tags, replaces existing tags if provided.
    pub tags: Option<Vec<String>>,
}

impl UpdateGoalParams {
    /// Creates a new empty `UpdateGoalParams`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the name to update (builder pattern).
    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }

    /// Sets the description to update (builder pattern).
    pub fn with_description(mut self, description: String) -> Self {
        self.description = Some(description);
        self
    }

    /// Sets the completion status (builder pattern).
    ///
    /// If `completed` is `true`, also sets `completed_at` to the current time.
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
    /// Creates a new empty `GoalFilters` with no filters applied.
    pub fn new() -> Self {
        Self::default()
    }

    /// Filters by owner type (builder pattern).
    pub fn with_owner_type(mut self, owner_type: GoalOwnerType) -> Self {
        self.owner_type = Some(owner_type);
        self
    }

    /// Filters by owner ID (builder pattern).
    pub fn with_owner_id(mut self, owner_id: String) -> Self {
        self.owner_id = Some(owner_id);
        self
    }

    /// Filters by completion status (builder pattern).
    pub fn with_completed(mut self, completed: bool) -> Self {
        self.is_completed = Some(completed);
        self
    }

    /// Filters by tags (builder pattern).
    ///
    /// Goals matching any of the provided tags will be included.
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.tags = Some(tags);
        self
    }
}

/// Information extracted from natural language about a goal.
///
/// Used when parsing user input to identify goal-related information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedGoalInfo {
    /// The extracted name of the goal.
    pub name: String,
    /// The extracted description, if any.
    pub description: Option<String>,
    /// The inferred owner type for the goal.
    #[serde(default)]
    pub owner_type: GoalOwnerType,
}

/// Result of checking for similar existing goals.
///
/// Used to detect potential duplicate goals before creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimilarityCheckResult {
    /// Whether a similar goal was found.
    pub has_similar: bool,
    /// The name of the similar goal, if found.
    pub similar_goal_name: Option<String>,
    /// Confidence level of the similarity match (0-100).
    pub confidence: u8,
}

/// Result of attempting to select a goal from a list.
///
/// Used when the user references a goal by name or description.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalSelectionResult {
    /// The ID of the selected goal, if found.
    pub goal_id: Option<String>,
    /// The name of the selected goal, if found.
    pub goal_name: Option<String>,
    /// Whether a matching goal was found.
    pub is_found: bool,
}

/// Result of parsing user confirmation input.
///
/// Used when awaiting user confirmation for goal operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmationResult {
    /// Whether the input was a confirmation response.
    pub is_confirmation: bool,
    /// Whether the user confirmed to proceed.
    pub should_proceed: bool,
    /// Any modifications the user requested.
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
