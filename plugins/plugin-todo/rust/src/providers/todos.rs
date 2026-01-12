#![allow(missing_docs)]
//! Todos Provider.

use crate::data_service::TodoDataService;
use crate::types::{TaskType, TodoFilters};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::info;
use uuid::Uuid;

/// Todos Provider.
///
/// Fetches and formats information about a user's tasks and points.
pub struct TodosProvider;

/// Result of todos provider.
pub struct TodosProviderResult {
    /// Text description.
    pub text: String,
    /// Values map.
    pub values: HashMap<String, serde_json::Value>,
    /// Data map.
    pub data: HashMap<String, serde_json::Value>,
}

impl TodosProvider {
    /// Provider name.
    pub const NAME: &'static str = "TODOS";

    /// Provider description.
    pub const DESCRIPTION: &'static str =
        "Information about the user's current tasks, completed tasks, and points";

    /// Whether the provider is dynamic.
    pub const DYNAMIC: bool = true;

    /// Get todos for a user.
    ///
    /// # Arguments
    ///
    /// * `data_service` - The todo data service
    /// * `entity_id` - The entity ID
    /// * `room_id` - Optional room ID to filter by
    ///
    /// # Returns
    ///
    /// The provider result.
    pub async fn get(
        data_service: Arc<TodoDataService>,
        entity_id: Uuid,
        room_id: Option<Uuid>,
    ) -> TodosProviderResult {
        info!("Getting TODOS provider data");

        let mut filters = TodoFilters {
            entity_id: Some(entity_id),
            ..Default::default()
        };

        if let Some(rid) = room_id {
            filters.room_id = Some(rid);
        }

        let all_todos = match data_service.get_todos(Some(filters)).await {
            todos if todos.is_empty() => {
                return TodosProviderResult {
                    text: "You don't have any tasks yet.".to_string(),
                    values: HashMap::new(),
                    data: HashMap::new(),
                };
            }
            todos => todos,
        };

        // Separate todos by type and completion status
        let mut daily_todos = Vec::new();
        let mut one_off_todos = Vec::new();
        let mut aspirational_todos = Vec::new();
        let mut completed_todos = Vec::new();

        for todo in all_todos {
            if todo.is_completed {
                completed_todos.push(todo);
            } else {
                match todo.task_type {
                    TaskType::Daily => daily_todos.push(todo),
                    TaskType::OneOff => one_off_todos.push(todo),
                    TaskType::Aspirational => aspirational_todos.push(todo),
                }
            }
        }

        // Format text descriptions
        let format_todos = |todos: &[crate::types::Todo]| -> String {
            if todos.is_empty() {
                "None".to_string()
            } else {
                todos
                    .iter()
                    .map(|t| {
                        let priority = t
                            .priority
                            .map(|p| format!(" (Priority {})", p as u8))
                            .unwrap_or_default();
                        let urgent = if t.is_urgent { " [URGENT]" } else { "" };
                        let due = t
                            .due_date
                            .map(|d| format!(" (Due: {})", d.format("%m/%d/%Y")))
                            .unwrap_or_default();
                        format!("- {}{}{}{}", t.name, priority, urgent, due)
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        };

        let formatted_daily = format_todos(&daily_todos);
        let formatted_one_off = format_todos(&one_off_todos);
        let formatted_aspirational = format_todos(&aspirational_todos);
        let formatted_completed = format_todos(&completed_todos);

        // Build text summary
        let mut text_parts = Vec::new();
        if !daily_todos.is_empty() {
            text_parts.push(format!(
                "Daily Tasks ({}):\n{}",
                daily_todos.len(),
                formatted_daily
            ));
        }
        if !one_off_todos.is_empty() {
            text_parts.push(format!(
                "One-Off Tasks ({}):\n{}",
                one_off_todos.len(),
                formatted_one_off
            ));
        }
        if !aspirational_todos.is_empty() {
            text_parts.push(format!(
                "Aspirational Goals ({}):\n{}",
                aspirational_todos.len(),
                formatted_aspirational
            ));
        }
        if !completed_todos.is_empty() {
            text_parts.push(format!(
                "Completed Tasks ({}):\n{}",
                completed_todos.len(),
                formatted_completed
            ));
        }

        let text = if text_parts.is_empty() {
            "You don't have any tasks yet.".to_string()
        } else {
            text_parts.join("\n\n")
        };

        // Build values map
        let mut values = HashMap::new();
        values.insert("dailyTasks".to_string(), serde_json::json!(formatted_daily));
        values.insert(
            "oneOffTasks".to_string(),
            serde_json::json!(formatted_one_off),
        );
        values.insert(
            "aspirationalTasks".to_string(),
            serde_json::json!(formatted_aspirational),
        );
        values.insert(
            "completedTasks".to_string(),
            serde_json::json!(formatted_completed),
        );

        // Build data map with structured todo arrays
        let mut data = HashMap::new();
        data.insert(
            "dailyTodos".to_string(),
            serde_json::json!(daily_todos.iter().map(todo_to_json).collect::<Vec<_>>()),
        );
        data.insert(
            "oneOffTodos".to_string(),
            serde_json::json!(one_off_todos.iter().map(todo_to_json).collect::<Vec<_>>()),
        );
        data.insert(
            "aspirationalTodos".to_string(),
            serde_json::json!(aspirational_todos
                .iter()
                .map(todo_to_json)
                .collect::<Vec<_>>()),
        );
        data.insert(
            "completedTodos".to_string(),
            serde_json::json!(completed_todos.iter().map(todo_to_json).collect::<Vec<_>>()),
        );

        TodosProviderResult { text, values, data }
    }
}

/// Convert a Todo to JSON value.
fn todo_to_json(todo: &crate::types::Todo) -> serde_json::Value {
    serde_json::json!({
        "id": todo.id.to_string(),
        "name": todo.name,
        "description": todo.description,
        "type": match todo.task_type {
            TaskType::Daily => "daily",
            TaskType::OneOff => "one-off",
            TaskType::Aspirational => "aspirational",
        },
        "priority": todo.priority.map(|p| p as u8),
        "isUrgent": todo.is_urgent,
        "isCompleted": todo.is_completed,
        "dueDate": todo.due_date.map(|d| d.to_rfc3339()),
        "completedAt": todo.completed_at.map(|d| d.to_rfc3339()),
        "createdAt": todo.created_at.to_rfc3339(),
        "updatedAt": todo.updated_at.to_rfc3339(),
        "tags": todo.tags,
    })
}
