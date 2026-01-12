#![allow(missing_docs)]
//! Update Todo Action.

use crate::data_service::TodoDataService;
use crate::types::{TodoFilters, UpdateTodoParams};
use std::sync::Arc;
use tracing::{error, info};
use uuid::Uuid;

/// Update Todo Action.
///
/// Updates an existing todo item immediately based on user description.
pub struct UpdateTodoAction;

/// Result of update todo action.
pub struct UpdateTodoResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
}

impl UpdateTodoAction {
    /// Action name.
    pub const NAME: &'static str = "UPDATE_TODO";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Updates an existing todo item immediately based on user description.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "UPDATE_TODO",
        "EDIT_TODO",
        "MODIFY_TASK",
        "CHANGE_TASK",
        "MODIFY_TODO",
        "EDIT_TASK",
    ];

    /// Handle the update todo action.
    ///
    /// # Arguments
    ///
    /// * `data_service` - The todo data service
    /// * `room_id` - The room ID
    /// * `task_id` - The task ID to update
    /// * `updates` - The updates to apply
    ///
    /// # Returns
    ///
    /// The action result.
    pub async fn handle(
        data_service: Arc<TodoDataService>,
        room_id: Uuid,
        task_id: Uuid,
        updates: UpdateTodoParams,
    ) -> UpdateTodoResult {
        info!("Handling UPDATE_TODO action");

        // Get active todos for this room
        let available_tasks = data_service
            .get_todos(Some(TodoFilters {
                room_id: Some(room_id),
                is_completed: Some(false),
                ..Default::default()
            }))
            .await;

        if available_tasks.is_empty() {
            return UpdateTodoResult {
                success: false,
                text: "You don't have any active tasks to update. Would you like to create a new task?".to_string(),
            };
        }

        if !available_tasks.iter().any(|t| t.id == task_id) {
            return UpdateTodoResult {
                success: false,
                text: "I couldn't find the task you want to update. Could you be more specific?"
                    .to_string(),
            };
        }

        match data_service.update_todo(task_id, updates.clone()).await {
            Ok(_) => {
                let updated_task = match data_service.get_todo(task_id).await {
                    Some(t) => t,
                    None => {
                        error!("Failed to retrieve updated todo");
                        return UpdateTodoResult {
                            success: false,
                            text: "Failed to update todo".to_string(),
                        };
                    }
                };

                let mut changes = Vec::new();
                if updates.name.is_some() {
                    changes.push(format!("name to \"{}\"", updated_task.name));
                }
                if updates.description.is_some() {
                    changes.push("description".to_string());
                }
                if updates.priority.is_some() {
                    changes.push(format!(
                        "priority to {}",
                        updated_task.priority.map(|p| p as u8).unwrap_or(3)
                    ));
                }
                if updates.is_urgent.is_some() {
                    changes.push(format!("urgency to {}", updated_task.is_urgent));
                }
                if updates.due_date.is_some() {
                    changes.push("due date".to_string());
                }

                let changes_text = if changes.is_empty() {
                    "task".to_string()
                } else {
                    changes.join(", ")
                };

                UpdateTodoResult {
                    success: true,
                    text: format!("✅ Updated {}: \"{}\"", changes_text, updated_task.name),
                }
            }
            Err(e) => {
                error!("Error updating todo: {}", e);
                UpdateTodoResult {
                    success: false,
                    text: format!("Failed to update todo: {}", e),
                }
            }
        }
    }
}
