#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageClassification {
    Simple,
    Strategic,
    CapabilityRequest,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionModel {
    #[default]
    Sequential,
    Parallel,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_retries: i32,
    pub backoff_ms: i64,
    pub backoff_multiplier: f64,
    pub on_error: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionStep {
    pub id: Uuid,
    pub action_name: String,
    #[serde(default)]
    pub parameters: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub dependencies: Vec<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_policy: Option<RetryPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanState {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time: Option<i64>,
    #[serde(default)]
    pub current_step_index: usize,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionPlan {
    pub id: Uuid,
    pub goal: String,
    pub steps: Vec<ActionStep>,
    pub execution_model: ExecutionModel,
    #[serde(default)]
    pub state: PlanState,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningContext {
    pub goal: String,
    #[serde(default)]
    pub constraints: Vec<PlanningConstraint>,
    #[serde(default)]
    pub available_actions: Vec<String>,
    #[serde(default)]
    pub available_providers: Vec<String>,
    #[serde(default)]
    pub preferences: Option<PlanningPreferences>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningConstraint {
    #[serde(rename = "type")]
    pub constraint_type: String,
    pub value: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlanningPreferences {
    #[serde(default)]
    pub execution_model: Option<ExecutionModel>,
    #[serde(default)]
    pub max_steps: Option<i32>,
    #[serde(default)]
    pub timeout_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanExecutionResult {
    pub plan_id: Uuid,
    pub success: bool,
    pub completed_steps: usize,
    pub total_steps: usize,
    #[serde(default)]
    pub results: Vec<ActionResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<String>>,
    #[serde(default)]
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptations: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    pub text: String,
    #[serde(default)]
    pub data: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub dag_id: String,
    pub status: String,
    pub completed_steps: Vec<String>,
    pub failed_steps: Vec<String>,
    pub results: HashMap<String, serde_json::Value>,
    pub errors: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassificationResult {
    pub classification: String,
    pub confidence: f64,
    pub complexity: String,
    pub planning_type: String,
    pub planning_required: bool,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub stakeholders: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
}
