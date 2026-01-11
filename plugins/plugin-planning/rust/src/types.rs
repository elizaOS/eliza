//! Type definitions for the Planning Plugin.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Message classification categories.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageClassification {
    /// Simple direct actions
    Simple,
    /// Strategic planning required
    Strategic,
    /// Capability request
    CapabilityRequest,
    /// Research needed
    ResearchNeeded,
}

impl std::fmt::Display for MessageClassification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Simple => write!(f, "simple"),
            Self::Strategic => write!(f, "strategic"),
            Self::CapabilityRequest => write!(f, "capability_request"),
            Self::ResearchNeeded => write!(f, "research_needed"),
        }
    }
}

/// Execution model for plans.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionModel {
    /// Execute steps one after another
    #[default]
    Sequential,
    /// Execute all steps simultaneously
    Parallel,
    /// Execute as a directed acyclic graph
    Dag,
}

impl std::fmt::Display for ExecutionModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sequential => write!(f, "sequential"),
            Self::Parallel => write!(f, "parallel"),
            Self::Dag => write!(f, "dag"),
        }
    }
}

/// Retry policy for action steps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPolicy {
    /// Maximum number of retries
    pub max_retries: i32,
    /// Initial backoff in milliseconds
    pub backoff_ms: i64,
    /// Backoff multiplier
    pub backoff_multiplier: f64,
    /// Action on error
    pub on_error: String, // "abort" | "continue" | "skip"
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            backoff_ms: 1000,
            backoff_multiplier: 2.0,
            on_error: "abort".to_string(),
        }
    }
}

/// Action step in a plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionStep {
    /// Unique step identifier
    pub id: Uuid,
    /// Name of the action to execute
    pub action_name: String,
    /// Parameters for the action
    #[serde(default)]
    pub parameters: HashMap<String, serde_json::Value>,
    /// Step dependencies (IDs of steps that must complete first)
    #[serde(default)]
    pub dependencies: Vec<Uuid>,
    /// Retry policy for this step
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_policy: Option<RetryPolicy>,
    /// Error handling behavior
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<String>,
}

/// Plan execution state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanState {
    /// Current status
    pub status: String, // "pending" | "running" | "completed" | "failed" | "cancelled"
    /// Start timestamp
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<i64>,
    /// End timestamp
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<i64>,
    /// Current step index
    #[serde(default)]
    pub current_step_index: usize,
    /// Error message if failed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for PlanState {
    fn default() -> Self {
        Self {
            status: "pending".to_string(),
            start_time: None,
            end_time: None,
            current_step_index: 0,
            error: None,
        }
    }
}

/// Complete action plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionPlan {
    /// Unique plan identifier
    pub id: Uuid,
    /// Goal of the plan
    pub goal: String,
    /// Steps to execute
    pub steps: Vec<ActionStep>,
    /// Execution model
    pub execution_model: ExecutionModel,
    /// Plan state
    #[serde(default)]
    pub state: PlanState,
    /// Additional metadata
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Planning context for comprehensive planning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningContext {
    /// Goal to achieve
    pub goal: String,
    /// Constraints on the plan
    #[serde(default)]
    pub constraints: Vec<PlanningConstraint>,
    /// Available actions
    #[serde(default)]
    pub available_actions: Vec<String>,
    /// Available providers
    #[serde(default)]
    pub available_providers: Vec<String>,
    /// Planning preferences
    #[serde(default)]
    pub preferences: Option<PlanningPreferences>,
}

/// Planning constraint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningConstraint {
    /// Constraint type
    #[serde(rename = "type")]
    pub constraint_type: String,
    /// Constraint value
    pub value: serde_json::Value,
    /// Description
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Planning preferences.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlanningPreferences {
    /// Preferred execution model
    #[serde(default)]
    pub execution_model: Option<ExecutionModel>,
    /// Maximum number of steps
    #[serde(default)]
    pub max_steps: Option<i32>,
    /// Timeout in milliseconds
    #[serde(default)]
    pub timeout_ms: Option<i64>,
}

/// Result of plan execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanExecutionResult {
    /// Plan ID
    pub plan_id: Uuid,
    /// Whether execution was successful
    pub success: bool,
    /// Number of completed steps
    pub completed_steps: usize,
    /// Total number of steps
    pub total_steps: usize,
    /// Results from each step
    #[serde(default)]
    pub results: Vec<ActionResult>,
    /// Errors encountered
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
    /// Duration in milliseconds
    #[serde(default)]
    pub duration: f64,
    /// Adaptations made during execution
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptations: Option<Vec<String>>,
}

/// Result from a single action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    /// Result text
    pub text: String,
    /// Result data
    #[serde(default)]
    pub data: HashMap<String, serde_json::Value>,
}

/// Execution result for internal tracking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    /// DAG ID
    pub dag_id: String,
    /// Status
    pub status: String,
    /// Completed step IDs
    pub completed_steps: Vec<String>,
    /// Failed step IDs
    pub failed_steps: Vec<String>,
    /// Results by step
    pub results: HashMap<String, serde_json::Value>,
    /// Errors by step
    pub errors: HashMap<String, String>,
}

/// Classification result from message classifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassificationResult {
    /// Legacy classification
    pub classification: String,
    /// Confidence score
    pub confidence: f64,
    /// Complexity level
    pub complexity: String,
    /// Planning type
    pub planning_type: String,
    /// Whether planning is required
    pub planning_required: bool,
    /// Required capabilities
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Stakeholders
    #[serde(default)]
    pub stakeholders: Vec<String>,
    /// Constraints
    #[serde(default)]
    pub constraints: Vec<String>,
    /// Dependencies
    #[serde(default)]
    pub dependencies: Vec<String>,
}


