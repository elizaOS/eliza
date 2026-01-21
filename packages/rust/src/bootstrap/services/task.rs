//! Task service implementation.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;

use super::{Service, ServiceType};

/// Task status values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

/// Task priority levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskPriority {
    Low = 3,
    Medium = 2,
    High = 1,
    Urgent = 0,
}

/// Represents a task in the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    /// Unique identifier
    pub id: Uuid,
    /// Task name
    pub name: String,
    /// Task description
    pub description: String,
    /// Task status
    pub status: TaskStatus,
    /// Task priority
    pub priority: TaskPriority,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    /// Completion timestamp
    pub completed_at: Option<DateTime<Utc>>,
    /// Additional metadata
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
    /// Assignee entity ID
    pub assignee_id: Option<Uuid>,
    /// Parent task ID
    pub parent_id: Option<Uuid>,
}

/// Service for managing tasks.
pub struct TaskService {
    tasks: HashMap<Uuid, Task>,
    runtime: Option<Arc<dyn IAgentRuntime>>,
}

impl TaskService {
    /// Create a new task service.
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            runtime: None,
        }
    }

    /// Create a new task.
    pub async fn create_task(
        &mut self,
        name: String,
        description: String,
        priority: TaskPriority,
        assignee_id: Option<Uuid>,
        parent_id: Option<Uuid>,
        metadata: Option<HashMap<String, serde_json::Value>>,
    ) -> Task {
        let now = Utc::now();
        let task = Task {
            id: Uuid::new_v4(),
            name,
            description,
            status: TaskStatus::Pending,
            priority,
            created_at: now,
            updated_at: now,
            completed_at: None,
            metadata: metadata.unwrap_or_default(),
            assignee_id,
            parent_id,
        };

        if let Some(runtime) = &self.runtime {
            runtime.log_debug("service:task", &format!("Task created: {}", task.id));
        }

        self.tasks.insert(task.id, task.clone());
        task
    }

    /// Get a task by ID.
    pub fn get_task(&self, task_id: Uuid) -> Option<&Task> {
        self.tasks.get(&task_id)
    }

    /// Update a task's status.
    pub fn update_task_status(&mut self, task_id: Uuid, status: TaskStatus) -> Option<&Task> {
        if let Some(task) = self.tasks.get_mut(&task_id) {
            task.status = status;
            task.updated_at = Utc::now();

            if status == TaskStatus::Completed {
                task.completed_at = Some(task.updated_at);
            }

            if let Some(runtime) = &self.runtime {
                runtime.log_debug(
                    "service:task",
                    &format!("Task {} status updated to {:?}", task_id, status),
                );
            }

            Some(task)
        } else {
            None
        }
    }

    /// Get all tasks with a specific status.
    pub fn get_tasks_by_status(&self, status: TaskStatus) -> Vec<&Task> {
        self.tasks.values().filter(|t| t.status == status).collect()
    }

    /// Get all pending tasks sorted by priority.
    pub fn get_pending_tasks(&self) -> Vec<&Task> {
        let mut pending: Vec<_> = self
            .tasks
            .values()
            .filter(|t| t.status == TaskStatus::Pending)
            .collect();

        pending.sort_by_key(|t| t.priority);
        pending
    }

    /// Complete a task.
    pub fn complete_task(&mut self, task_id: Uuid) -> Option<&Task> {
        self.update_task_status(task_id, TaskStatus::Completed)
    }

    /// Cancel a task.
    pub fn cancel_task(&mut self, task_id: Uuid) -> Option<&Task> {
        self.update_task_status(task_id, TaskStatus::Cancelled)
    }

    /// Delete a task.
    pub fn delete_task(&mut self, task_id: Uuid) -> bool {
        if self.tasks.remove(&task_id).is_some() {
            if let Some(runtime) = &self.runtime {
                runtime.log_debug("service:task", &format!("Task deleted: {}", task_id));
            }
            true
        } else {
            false
        }
    }
}

impl Default for TaskService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Service for TaskService {
    fn name(&self) -> &'static str {
        "task"
    }

    fn service_type(&self) -> ServiceType {
        ServiceType::Core
    }

    async fn start(&mut self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("service:task", "Task service started");
        self.runtime = Some(runtime);
        Ok(())
    }

    async fn stop(&mut self) -> PluginResult<()> {
        if let Some(runtime) = &self.runtime {
            runtime.log_info("service:task", "Task service stopped");
        }
        self.tasks.clear();
        self.runtime = None;
        Ok(())
    }
}
