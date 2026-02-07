#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

/// Status of an individual task within a plan
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskStatus::Pending => write!(f, "pending"),
            TaskStatus::InProgress => write!(f, "in_progress"),
            TaskStatus::Completed => write!(f, "completed"),
            TaskStatus::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl Default for TaskStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// Status of an overall plan
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Draft,
    Active,
    Completed,
    Archived,
}

impl std::fmt::Display for PlanStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanStatus::Draft => write!(f, "draft"),
            PlanStatus::Active => write!(f, "active"),
            PlanStatus::Completed => write!(f, "completed"),
            PlanStatus::Archived => write!(f, "archived"),
        }
    }
}

impl Default for PlanStatus {
    fn default() -> Self {
        Self::Draft
    }
}

/// A single task within a plan
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    pub order: i32,
    pub dependencies: Vec<String>,
    pub assignee: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
}

/// A complete plan with tasks
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: PlanStatus,
    pub tasks: Vec<Task>,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: serde_json::Value,
}

/// Source identifier for plans created by this plugin
pub const PLAN_SOURCE: &str = "plugin-planning";

/// Generate a task ID from an index
pub fn generate_task_id(index: usize) -> String {
    format!("task-{}", index + 1)
}

/// Encode a plan to a storable JSON string
pub fn encode_plan(plan: &Plan) -> String {
    serde_json::to_string(plan).unwrap_or_default()
}

/// Decode a plan from a stored JSON string
pub fn decode_plan(text: &str) -> Option<Plan> {
    serde_json::from_str::<Plan>(text).ok().filter(|p| !p.id.is_empty() && !p.title.is_empty())
}

/// Calculate plan completion percentage
pub fn get_plan_progress(plan: &Plan) -> u32 {
    if plan.tasks.is_empty() {
        return 0;
    }
    let completed = plan
        .tasks
        .iter()
        .filter(|t| t.status == TaskStatus::Completed)
        .count();
    ((completed as f64 / plan.tasks.len() as f64) * 100.0).round() as u32
}

/// Format a plan as a readable string
pub fn format_plan(plan: &Plan) -> String {
    let progress = get_plan_progress(plan);

    let header = format!(
        "Plan: {}\nStatus: {} | Progress: {}%\n{}",
        plan.title, plan.status, progress, plan.description
    );

    let mut sorted_tasks = plan.tasks.clone();
    sorted_tasks.sort_by_key(|t| t.order);

    let task_lines: Vec<String> = sorted_tasks
        .iter()
        .map(|t| {
            let icon = match t.status {
                TaskStatus::Completed => "[x]",
                TaskStatus::InProgress => "[~]",
                TaskStatus::Cancelled => "[-]",
                TaskStatus::Pending => "[ ]",
            };
            let assignee = t
                .assignee
                .as_ref()
                .map(|a| format!(" (@{})", a))
                .unwrap_or_default();
            format!("  {} {}{}", icon, t.title, assignee)
        })
        .collect();

    format!("{}\n\nTasks:\n{}", header, task_lines.join("\n"))
}

/// Result from an action handler
#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub text: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ActionResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: None,
        }
    }

    pub fn success_with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            success: true,
            data: Some(data),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            success: false,
            data: None,
        }
    }
}

/// Result from a provider
#[derive(Debug, Clone, Serialize)]
pub struct ProviderResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ProviderResult {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            data: None,
        }
    }

    pub fn with_data(text: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            text: text.into(),
            data: Some(data),
        }
    }
}
