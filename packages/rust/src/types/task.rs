//! Task types for elizaOS
//!
//! Contains Task, TaskWorker, and related types for task management.

use serde::{Deserialize, Serialize};

use super::primitives::{Metadata, UUID};

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

/// Represents a task
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Unique identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<UUID>,
    /// Task name
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
    /// Tags for filtering
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Task metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,
    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Update timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    /// Scheduled execution time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<i64>,
    /// Repeat interval in milliseconds
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_interval: Option<i64>,
    /// Task data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Task {
    /// Create a new task
    pub fn new(name: &str) -> Self {
        Task {
            id: Some(UUID::new_v4()),
            name: name.to_string(),
            description: None,
            status: Some(TaskStatus::Pending),
            room_id: None,
            world_id: None,
            entity_id: None,
            tags: None,
            metadata: None,
            created_at: Some(current_timestamp()),
            updated_at: Some(current_timestamp()),
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

    /// Create a repeating task
    pub fn repeating(name: &str, interval_ms: i64) -> Self {
        let mut task = Task::new(name);
        task.repeat_interval = Some(interval_ms);
        task
    }
}

/// Task worker definition
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
}
