#![allow(missing_docs)]
//! Type definitions for the Todo Plugin.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// Task types supported by the plugin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum TaskType {
    /// Daily recurring task
    Daily,
    /// One-off task with optional due date
    #[default]
    OneOff,
    /// Aspirational long-term goal
    Aspirational,
}

/// Priority levels (1 = highest, 4 = lowest).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
#[derive(Default)]
pub enum Priority {
    /// Critical priority (1)
    Critical = 1,
    /// High priority (2)
    High = 2,
    /// Medium priority (3)
    #[default]
    Medium = 3,
    /// Low priority (4)
    Low = 4,
}

impl From<u8> for Priority {
    fn from(value: u8) -> Self {
        match value {
            1 => Self::Critical,
            2 => Self::High,
            3 => Self::Medium,
            _ => Self::Low,
        }
    }
}

/// Recurring patterns for daily tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RecurringPattern {
    /// Daily recurrence
    #[default]
    Daily,
    /// Weekly recurrence
    Weekly,
    /// Monthly recurrence
    Monthly,
}

/// Notification types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationType {
    /// Overdue task notification
    Overdue,
    /// Upcoming task reminder
    Upcoming,
    /// Daily task reminder
    Daily,
    /// System notification
    System,
}

/// Metadata stored with todos.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TodoMetadata {
    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Due date string
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    /// Completion timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    /// Whether completed today (for daily tasks)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_today: Option<bool>,
    /// Last completion date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_completed_date: Option<String>,
    /// Current streak
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streak: Option<i32>,
    /// Recurring pattern
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurring: Option<RecurringPattern>,
    /// Points awarded for completion
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points_awarded: Option<i32>,
    /// Additional custom fields
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Core todo item structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    /// Unique identifier
    pub id: Uuid,
    /// Agent ID
    pub agent_id: Uuid,
    /// World ID
    pub world_id: Uuid,
    /// Room ID
    pub room_id: Uuid,
    /// Entity ID (creator)
    pub entity_id: Uuid,
    /// Task name
    pub name: String,
    /// Task description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Task type
    #[serde(rename = "type")]
    pub task_type: TaskType,
    /// Priority level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// Whether the task is urgent
    pub is_urgent: bool,
    /// Whether the task is completed
    pub is_completed: bool,
    /// Due date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<DateTime<Utc>>,
    /// Completion timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    /// Metadata
    pub metadata: TodoMetadata,
    /// Tags
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Parameters for creating a new todo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTodoParams {
    /// Agent ID
    pub agent_id: Uuid,
    /// World ID
    pub world_id: Uuid,
    /// Room ID
    pub room_id: Uuid,
    /// Entity ID
    pub entity_id: Uuid,
    /// Task name
    pub name: String,
    /// Task description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Task type
    #[serde(rename = "type")]
    pub task_type: TaskType,
    /// Priority level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// Whether the task is urgent
    #[serde(default)]
    pub is_urgent: bool,
    /// Due date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<DateTime<Utc>>,
    /// Metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<TodoMetadata>,
    /// Tags
    #[serde(default)]
    pub tags: Vec<String>,
}

impl Default for CreateTodoParams {
    fn default() -> Self {
        Self {
            agent_id: Uuid::nil(),
            world_id: Uuid::nil(),
            room_id: Uuid::nil(),
            entity_id: Uuid::nil(),
            name: String::new(),
            description: None,
            task_type: TaskType::OneOff,
            priority: None,
            is_urgent: false,
            due_date: None,
            metadata: None,
            tags: Vec::new(),
        }
    }
}

/// Parameters for updating a todo.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateTodoParams {
    /// New name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// New priority
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// New urgency status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_urgent: Option<bool>,
    /// New completion status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_completed: Option<bool>,
    /// New due date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<DateTime<Utc>>,
    /// Completion timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// New metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<TodoMetadata>,
}

/// Filter parameters for querying todos.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TodoFilters {
    /// Filter by agent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<Uuid>,
    /// Filter by world
    #[serde(skip_serializing_if = "Option::is_none")]
    pub world_id: Option<Uuid>,
    /// Filter by room
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<Uuid>,
    /// Filter by entity
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<Uuid>,
    /// Filter by task type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_type: Option<TaskType>,
    /// Filter by completion status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_completed: Option<bool>,
    /// Filter by tags
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Maximum number to return
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// Reminder metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderMetadata {
    /// Todo ID
    pub todo_id: Uuid,
    /// Todo name
    pub todo_name: String,
    /// Reminder type
    pub reminder_type: String,
    /// Due date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<DateTime<Utc>>,
}

/// Reminder message structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderMessage {
    /// Entity ID
    pub entity_id: Uuid,
    /// Message content
    pub message: String,
    /// Priority level
    pub priority: String,
    /// Target platforms
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    /// Reminder metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ReminderMetadata>,
}

/// Task selection from extraction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSelection {
    /// Task ID
    pub task_id: String,
    /// Task name
    pub task_name: String,
    /// Whether found
    pub is_found: bool,
}

/// Task update properties.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskUpdate {
    /// New name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// New priority
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// New urgency
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urgent: Option<bool>,
    /// New due date
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    /// New recurring pattern
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurring: Option<RecurringPattern>,
}

/// Confirmation response from user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmationResponse {
    /// Whether this is a confirmation
    pub is_confirmation: bool,
    /// Whether to proceed
    pub should_proceed: bool,
    /// Any modifications
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifications: Option<String>,
}

/// Pending todo waiting for user confirmation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingTodo {
    /// Task name
    pub name: String,
    /// Task description
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Task type
    #[serde(rename = "taskType")]
    pub task_type: TaskType,
    /// Priority level
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// Whether the task is urgent
    #[serde(default)]
    pub urgent: bool,
    /// Due date
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "dueDate")]
    pub due_date: Option<DateTime<Utc>>,
    /// Recurring pattern
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurring: Option<RecurringPattern>,
    /// Tags
    #[serde(default)]
    pub tags: Vec<String>,
    /// Metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<TodoMetadata>,
}
