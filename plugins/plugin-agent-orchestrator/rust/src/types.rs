//! Type definitions for the Agent Orchestrator plugin.
//!
//! These types mirror the TypeScript definitions for cross-platform parity.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// JSON-safe value type
pub type JsonValue = serde_json::Value;

/// Execution status of a task
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum TaskStatus {
    #[default]
    Pending,
    Running,
    Completed,
    Failed,
    Paused,
    Cancelled,
}


impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "pending"),
            Self::Running => write!(f, "running"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
            Self::Paused => write!(f, "paused"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

/// User-controlled lifecycle status (separate from execution status)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum TaskUserStatus {
    #[default]
    Open,
    Done,
}


/// A single step within a task plan
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStep {
    pub id: String,
    pub description: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, JsonValue>,
}

impl TaskStep {
    /// Create a new task step
    pub fn new(description: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            description: description.into(),
            status: TaskStatus::Pending,
            output: None,
            extra: HashMap::new(),
        }
    }
}

/// Result of task execution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub success: bool,
    pub summary: String,
    pub files_modified: Vec<String>,
    pub files_created: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, JsonValue>,
}

impl TaskResult {
    /// Create a successful result
    pub fn success(summary: impl Into<String>) -> Self {
        Self {
            success: true,
            summary: summary.into(),
            files_modified: Vec::new(),
            files_created: Vec::new(),
            error: None,
            extra: HashMap::new(),
        }
    }

    /// Create a failed result
    pub fn failure(summary: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            success: false,
            summary: summary.into(),
            files_modified: Vec::new(),
            files_created: Vec::new(),
            error: Some(error.into()),
            extra: HashMap::new(),
        }
    }
}

/// Provider identifier type
pub type AgentProviderId = String;

/// Metadata for an orchestrated task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratedTaskMetadata {
    pub status: TaskStatus,
    pub progress: i32,
    pub output: Vec<String>,
    pub steps: Vec<TaskStep>,
    pub working_directory: String,
    pub provider_id: AgentProviderId,
    pub created_at: i64,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<TaskResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_agent_type: Option<String>,
    #[serde(default)]
    pub user_status: TaskUserStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_status_updated_at: Option<i64>,
    #[serde(default)]
    pub files_created: Vec<String>,
    #[serde(default)]
    pub files_modified: Vec<String>,

    #[serde(flatten)]
    pub extra: HashMap<String, JsonValue>,
}

impl OrchestratedTaskMetadata {
    /// Create new metadata with defaults
    pub fn new(provider_id: impl Into<String>, working_directory: impl Into<String>) -> Self {
        let now = chrono_now();
        Self {
            status: TaskStatus::Pending,
            progress: 0,
            output: Vec::new(),
            steps: Vec::new(),
            working_directory: working_directory.into(),
            provider_id: provider_id.into(),
            created_at: now,
            result: None,
            error: None,
            started_at: None,
            completed_at: None,
            provider_label: None,
            sub_agent_type: None,
            user_status: TaskUserStatus::Open,
            user_status_updated_at: Some(now),
            files_created: Vec::new(),
            files_modified: Vec::new(),
            extra: HashMap::new(),
        }
    }
}

/// A task managed by the orchestrator
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratedTask {
    pub id: String,
    pub name: String,
    pub description: String,
    pub metadata: OrchestratedTaskMetadata,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<String>,
}

/// Context provided to agent providers during task execution
pub struct ProviderTaskExecutionContext {
    pub runtime_agent_id: String,
    pub working_directory: String,
    pub room_id: Option<String>,
    pub world_id: Option<String>,
    pub append_output: Box<dyn Fn(String) + Send + Sync>,
    pub update_progress: Box<dyn Fn(i32) + Send + Sync>,
    pub update_step: Box<dyn Fn(String, TaskStatus, Option<String>) + Send + Sync>,
    pub is_cancelled: Box<dyn Fn() -> bool + Send + Sync>,
    pub is_paused: Box<dyn Fn() -> bool + Send + Sync>,
}

/// Trait for agent providers that can execute tasks
#[async_trait::async_trait]
pub trait AgentProvider: Send + Sync {
    /// Unique identifier for this provider
    fn id(&self) -> &str;

    /// Human-readable label for this provider
    fn label(&self) -> &str;

    /// Optional description of this provider
    fn description(&self) -> Option<&str> {
        None
    }

    /// Execute the given task and return the result
    async fn execute_task(
        &self,
        task: &OrchestratedTask,
        ctx: &ProviderTaskExecutionContext,
    ) -> TaskResult;
}

/// Types of task events
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskEventType {
    #[serde(rename = "task:created")]
    Created,
    #[serde(rename = "task:started")]
    Started,
    #[serde(rename = "task:progress")]
    Progress,
    #[serde(rename = "task:output")]
    Output,
    #[serde(rename = "task:completed")]
    Completed,
    #[serde(rename = "task:failed")]
    Failed,
    #[serde(rename = "task:cancelled")]
    Cancelled,
    #[serde(rename = "task:paused")]
    Paused,
    #[serde(rename = "task:resumed")]
    Resumed,
    #[serde(rename = "task:message")]
    Message,
}

/// Event emitted by the orchestrator service
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEvent {
    #[serde(rename = "type")]
    pub event_type: TaskEventType,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<HashMap<String, JsonValue>>,
}

/// Get current time in milliseconds
fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
