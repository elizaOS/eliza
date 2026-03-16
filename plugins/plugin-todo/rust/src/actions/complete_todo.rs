#![allow(missing_docs)]
//! Complete Todo Action.

use crate::data_service::TodoDataService;
use crate::types::{TaskType, TodoFilters, UpdateTodoParams};
use chrono::Utc;
use std::sync::Arc;
use tracing::{error, info};
use uuid::Uuid;

/// Complete Todo Action.
///
/// Marks a todo item as completed.
pub struct CompleteTodoAction;

/// Result of complete todo action.
pub struct CompleteTodoResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
}

impl CompleteTodoAction {
    /// Action name.
    pub const NAME: &'static str = "COMPLETE_TODO";

    /// Action description.
    pub const DESCRIPTION: &'static str = "Marks a todo item as completed.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "COMPLETE_TODO",
        "MARK_COMPLETE",
        "FINISH_TASK",
        "DONE",
        "TASK_DONE",
        "TASK_COMPLETED",
    ];

    /// Handle the complete todo action.
    ///
    /// # Arguments
    ///
    /// * `data_service` - The todo data service
    /// * `room_id` - The room ID
    /// * `task_id` - Optional task ID to complete. If None, completes the first incomplete task.
    ///
    /// # Returns
    ///
    /// The action result.
    pub async fn handle(
        data_service: Arc<TodoDataService>,
        room_id: Uuid,
        task_id: Option<Uuid>,
    ) -> CompleteTodoResult {
        info!("Handling COMPLETE_TODO action");

        // Get incomplete todos for this room
        let available_todos = data_service
            .get_todos(Some(TodoFilters {
                room_id: Some(room_id),
                is_completed: Some(false),
                ..Default::default()
            }))
            .await;

        if available_todos.is_empty() {
            return CompleteTodoResult {
                success: false,
                text: "You don't have any incomplete tasks to mark as done. Would you like to create a new task?".to_string(),
            };
        }

        let todo = if let Some(id) = task_id {
            available_todos.iter().find(|t| t.id == id)
        } else {
            available_todos.first()
        };

        let todo = match todo {
            Some(t) => t,
            None => {
                return CompleteTodoResult {
                    success: false,
                    text:
                        "I couldn't find the task you want to complete. Could you be more specific?"
                            .to_string(),
                };
            }
        };

        let now = Utc::now();
        let mut metadata = todo.metadata.clone();
        metadata.completed_at = Some(now.to_rfc3339());

        let updates = UpdateTodoParams {
            is_completed: Some(true),
            completed_at: Some(now),
            metadata: Some(metadata),
            ..Default::default()
        };

        match data_service.update_todo(todo.id, updates).await {
            Ok(_) => {
                let response_text = match todo.task_type {
                    TaskType::Daily => {
                        format!(
                            "✅ Completed daily task: \"{}\". Great job maintaining your streak!",
                            todo.name
                        )
                    }
                    TaskType::OneOff => {
                        format!("✅ Completed task: \"{}\". Well done!", todo.name)
                    }
                    TaskType::Aspirational => {
                        format!("✅ Progress made on goal: \"{}\". Keep it up!", todo.name)
                    }
                };

                CompleteTodoResult {
                    success: true,
                    text: response_text,
                }
            }
            Err(e) => {
                error!("Error completing todo: {}", e);
                CompleteTodoResult {
                    success: false,
                    text: format!("Failed to complete todo: {}", e),
                }
            }
        }
    }
}
