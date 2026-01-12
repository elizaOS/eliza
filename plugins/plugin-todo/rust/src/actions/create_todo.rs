#![allow(missing_docs)]
//! Create Todo Action.

use crate::data_service::TodoDataService;
use crate::types::{CreateTodoParams, TaskType};
use std::sync::Arc;
use tracing::{error, info};
use uuid::Uuid;

/// Create Todo Action.
///
/// Creates a new todo item from a user description.
pub struct CreateTodoAction;

/// Result of create todo action.
pub struct CreateTodoResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
    /// Created todo ID if successful.
    pub todo_id: Option<Uuid>,
}

impl CreateTodoAction {
    /// Action name.
    pub const NAME: &'static str = "CREATE_TODO";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "CREATE_TODO",
        "ADD_TODO",
        "NEW_TASK",
        "ADD_TASK",
        "CREATE_TASK",
    ];

    /// Handle the create todo action.
    ///
    /// # Arguments
    ///
    /// * `data_service` - The todo data service
    /// * `params` - Parameters for creating the todo
    ///
    /// # Returns
    ///
    /// The action result.
    pub async fn handle(
        data_service: Arc<TodoDataService>,
        params: CreateTodoParams,
    ) -> CreateTodoResult {
        info!("Handling CREATE_TODO action");

        if params.name.trim().is_empty() {
            return CreateTodoResult {
                success: false,
                text: "I cannot create a todo without a name. Please provide a task name."
                    .to_string(),
                todo_id: None,
            };
        }

        // Check for duplicates
        let existing_todos = data_service
            .get_todos(Some(crate::types::TodoFilters {
                entity_id: Some(params.entity_id),
                room_id: Some(params.room_id),
                is_completed: Some(false),
                ..Default::default()
            }))
            .await;

        let duplicate = existing_todos
            .iter()
            .find(|t| t.name.trim().to_lowercase() == params.name.trim().to_lowercase());

        if let Some(dup) = duplicate {
            return CreateTodoResult {
                success: false,
                text: format!(
                    "You already have an active task named \"{}\". I haven't added a duplicate.",
                    dup.name
                ),
                todo_id: None,
            };
        }

        match data_service.create_todo(params.clone()).await {
            Ok(todo_id) => {
                let todo = match data_service.get_todo(todo_id).await {
                    Some(t) => t,
                    None => {
                        error!("Failed to retrieve created todo");
                        return CreateTodoResult {
                            success: false,
                            text: "Failed to create todo".to_string(),
                            todo_id: None,
                        };
                    }
                };

                let response_text = match todo.task_type {
                    TaskType::Daily => {
                        format!(
                            "✅ Created daily task: \"{}\". Complete it regularly to build your streak!",
                            todo.name
                        )
                    }
                    TaskType::OneOff => {
                        let priority_text = todo
                            .priority
                            .map(|p| format!("Priority {}", p as u8))
                            .unwrap_or_else(|| "Priority 3".to_string());
                        let urgent_text = if todo.is_urgent { ", Urgent" } else { "" };
                        let due_date_text = todo
                            .due_date
                            .map(|d| format!(", Due: {}", d.format("%m/%d/%Y")))
                            .unwrap_or_default();
                        format!(
                            "✅ Created task: \"{}\" ({}{}{})",
                            todo.name, priority_text, urgent_text, due_date_text
                        )
                    }
                    TaskType::Aspirational => {
                        format!("✅ Created aspirational goal: \"{}\"", todo.name)
                    }
                };

                CreateTodoResult {
                    success: true,
                    text: response_text,
                    todo_id: Some(todo_id),
                }
            }
            Err(e) => {
                error!("Error creating todo: {}", e);
                CreateTodoResult {
                    success: false,
                    text: format!("Failed to create todo: {}", e),
                    todo_id: None,
                }
            }
        }
    }
}
