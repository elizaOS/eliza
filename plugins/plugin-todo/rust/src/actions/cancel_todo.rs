#![allow(missing_docs)]
//! Cancel Todo Action.

use crate::data_service::TodoDataService;
use crate::types::TodoFilters;
use std::sync::Arc;
use tracing::{error, info};
use uuid::Uuid;

/// Cancel Todo Action.
///
/// Cancels and deletes a todo item from the user's task list immediately.
pub struct CancelTodoAction;

/// Result of cancel todo action.
pub struct CancelTodoResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
}

impl CancelTodoAction {
    /// Action name.
    pub const NAME: &'static str = "CANCEL_TODO";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Cancels and deletes a todo item from the user's task list immediately.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "CANCEL_TODO",
        "DELETE_TODO",
        "REMOVE_TASK",
        "DELETE_TASK",
        "REMOVE_TODO",
    ];

    /// Handle the cancel todo action.
    ///
    /// # Arguments
    ///
    /// * `data_service` - The todo data service
    /// * `room_id` - The room ID
    /// * `task_id` - The task ID to cancel
    ///
    /// # Returns
    ///
    /// The action result.
    pub async fn handle(
        data_service: Arc<TodoDataService>,
        room_id: Uuid,
        task_id: Uuid,
    ) -> CancelTodoResult {
        info!("Handling CANCEL_TODO action");

        // Get active todos for this room
        let available_tasks = data_service
            .get_todos(Some(TodoFilters {
                room_id: Some(room_id),
                is_completed: Some(false),
                ..Default::default()
            }))
            .await;

        if available_tasks.is_empty() {
            return CancelTodoResult {
                success: false,
                text: "You don't have any active tasks to cancel. Would you like to create a new task?".to_string(),
            };
        }

        let task = available_tasks.iter().find(|t| t.id == task_id);

        let task = match task {
            Some(t) => t,
            None => {
                return CancelTodoResult {
                    success: false,
                    text:
                        "I couldn't find the task you want to cancel. Could you be more specific?"
                            .to_string(),
                };
            }
        };

        let task_name = task.name.clone();

        match data_service.delete_todo(task_id).await {
            Ok(_) => CancelTodoResult {
                success: true,
                text: format!(
                    "✓ Task cancelled: \"{}\" has been removed from your todo list.",
                    task_name
                ),
            },
            Err(e) => {
                error!("Error cancelling todo: {}", e);
                CancelTodoResult {
                    success: false,
                    text: format!("Failed to cancel todo: {}", e),
                }
            }
        }
    }
}
