//! Task types for elizaOS
//!
//! Contains Task, TaskWorker, TaskMetadata, and related types for task management.
//! This module provides parity with the TypeScript task system.

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;

use super::memory::Memory;
use super::primitives::UUID;
use super::state::State;

/// Task worker trait - defines the contract for executing tasks.
/// Parity with TypeScript's TaskWorker interface.
///
/// The runtime parameter is passed as `&dyn Any` to avoid circular dependencies.
/// Implementations should downcast to the concrete runtime type.
#[async_trait]
pub trait TaskWorker: Send + Sync {
    /// The unique name of the task type this worker handles
    fn name(&self) -> &str;

    /// Execute the task.
    /// The runtime is passed as `Arc<dyn Any + Send + Sync>` to allow downcasting.
    async fn execute(
        &self,
        runtime: Arc<dyn Any + Send + Sync>,
        options: HashMap<String, serde_json::Value>,
        task: Task,
    ) -> Result<()>;

    /// Optional validation function (defaults to true).
    async fn validate(
        &self,
        _runtime: Arc<dyn Any + Send + Sync>,
        _message: &Memory,
        _state: &State,
    ) -> bool {
        true
    }
}

/// Boxed task worker for storage
pub type BoxedTaskWorker = Arc<dyn TaskWorker>;

/// Task status
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Task is pending
    #[default]
    Pending,
    /// Task is in progress
    InProgress,
    /// Task completed
    Completed,
    /// Task failed
    Failed,
    /// Task cancelled
    Cancelled,
}

impl TaskStatus {
    /// Convert to string representation for database storage
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Task metadata containing scheduling and configuration information.
/// Provides parity with TypeScript's TaskMetadata interface.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMetadata {
    /// Target entity ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_entity_id: Option<String>,
    /// Reason for the task
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Task priority
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    /// Task message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Task status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Scheduled execution time (ISO string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<String>,
    /// When task was snoozed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snoozed_at: Option<String>,
    /// Original scheduled time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_scheduled_at: Option<serde_json::Value>,
    /// Creation time (ISO string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Completion time (ISO string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    /// Notes on completion
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_notes: Option<String>,
    /// Last execution time (ISO string)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_executed: Option<String>,
    /// Last update timestamp in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    /// Interval in milliseconds between updates or executions for recurring tasks
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_interval: Option<i64>,
    /// If true (default), the task will block the next scheduled execution while running.
    /// Set to false to allow overlapping executions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking: Option<bool>,
    /// Options for UI presentation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<TaskOption>>,
    /// Additional values
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<HashMap<String, serde_json::Value>>,
}

/// Task option for UI presentation
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskOption {
    /// Option name
    pub name: String,
    /// Option description
    pub description: String,
}

/// Represents a task to be performed, often in the background or at a later time.
/// Tasks are managed by the AgentRuntime and processed by registered TaskWorkers.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Task name (links to TaskWorker)
    pub name: String,
    /// Task description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Task status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatus>,
    /// Room ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// World ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<UUID>,
    /// Entity ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<UUID>,
    /// Tags for filtering (e.g., "queue", "repeat")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Task metadata (includes updateInterval, blocking, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<TaskMetadata>,
    /// Creation timestamp in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Update timestamp in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    /// Scheduled execution time in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<i64>,
    /// Legacy: Repeat interval in milliseconds (use metadata.update_interval instead)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_interval: Option<i64>,
    /// Task data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Task {
    /// Create a new task
    pub fn new(name: &str) -> Self {
        let now = current_timestamp();
        Task {
            id: Some(UUID::new_v4()),
            name: name.to_string(),
            description: None,
            status: Some(TaskStatus::Pending),
            room_id: None,
            world_id: None,
            entity_id: None,
            tags: None,
            metadata: Some(TaskMetadata {
                updated_at: Some(now),
                created_at: Some(now.to_string()),
                ..Default::default()
            }),
            created_at: Some(now),
            updated_at: Some(now),
            scheduled_at: None,
            repeat_interval: None,
            data: None,
        }
    }

    /// Create a scheduled task
    pub fn scheduled(name: &str, scheduled_at: i64) -> Self {
        let mut task = Task::new(name);
        task.scheduled_at = Some(scheduled_at);
        task
    }

    /// Create a repeating task with the given interval
    pub fn repeating(name: &str, interval_ms: i64) -> Self {
        let mut task = Task::new(name);
        task.tags = Some(vec!["queue".to_string(), "repeat".to_string()]);
        task.metadata = Some(TaskMetadata {
            update_interval: Some(interval_ms),
            blocking: Some(true), // Default to blocking
            ..task.metadata.unwrap_or_default()
        });
        task
    }

    /// Create a repeating task with blocking configuration
    pub fn repeating_with_blocking(name: &str, interval_ms: i64, blocking: bool) -> Self {
        let mut task = Task::repeating(name, interval_ms);
        if let Some(ref mut meta) = task.metadata {
            meta.blocking = Some(blocking);
        }
        task
    }

    /// Check if this task is a repeating task
    pub fn is_repeating(&self) -> bool {
        self.tags
            .as_ref()
            .map(|t| t.contains(&"repeat".to_string()))
            .unwrap_or(false)
    }

    /// Check if this task should block overlapping executions
    pub fn is_blocking(&self) -> bool {
        self.metadata
            .as_ref()
            .and_then(|m| m.blocking)
            .unwrap_or(true) // Default to blocking
    }

    /// Get the update interval in milliseconds
    pub fn get_update_interval(&self) -> Option<i64> {
        self.metadata.as_ref().and_then(|m| m.update_interval)
    }
}

/// Task worker definition (for serialization)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkerDefinition {
    /// Worker name
    pub name: String,
    /// Worker description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Parameters for getting tasks
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTasksParams {
    /// Room ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<UUID>,
    /// Tags filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Entity ID filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<UUID>,
}

fn current_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_creation() {
        let task = Task::new("test-task");
        assert_eq!(task.name, "test-task");
        assert_eq!(task.status, Some(TaskStatus::Pending));
        assert!(task.id.is_some());
    }

    #[test]
    fn test_task_serialization() {
        let task = Task::new("test-task");
        let json = serde_json::to_string(&task).unwrap();

        assert!(json.contains("\"name\":\"test-task\""));
        // Status is now snake_case
        assert!(json.contains("\"status\":\"pending\""));
    }

    #[test]
    fn test_task_status_in_progress() {
        let mut task = Task::new("running-task");
        task.status = Some(TaskStatus::InProgress);
        let json = serde_json::to_string(&task).unwrap();
        assert!(json.contains("\"status\":\"in_progress\""));
    }

    #[test]
    fn test_repeating_task() {
        let task = Task::repeating("heartbeat", 30000);
        assert!(task.is_repeating());
        assert!(task.is_blocking());
        assert_eq!(task.get_update_interval(), Some(30000));
        assert!(task.tags.as_ref().unwrap().contains(&"queue".to_string()));
        assert!(task.tags.as_ref().unwrap().contains(&"repeat".to_string()));
    }

    #[test]
    fn test_repeating_task_non_blocking() {
        let task = Task::repeating_with_blocking("async-task", 5000, false);
        assert!(task.is_repeating());
        assert!(!task.is_blocking());
    }

    #[test]
    fn test_task_metadata_blocking_default() {
        let task = Task::new("test");
        // Without explicit metadata, is_blocking should return true (default)
        assert!(task.is_blocking());
    }
}
