#![allow(missing_docs)]
//! Confirm Todo Action.

use crate::data_service::TodoDataService;
use crate::types::{ConfirmationResponse, CreateTodoParams, PendingTodo, TaskType, TodoFilters};
use std::sync::Arc;
use tracing::{error, info};
use uuid::Uuid;

/// Confirm Todo Action.
///
/// Confirms or cancels a pending todo creation after user review.
pub struct ConfirmTodoAction;

/// Result of confirm todo action.
pub struct ConfirmTodoResult {
    /// Whether the action succeeded.
    pub success: bool,
    /// Result text.
    pub text: String,
    /// Created todo ID if successful.
    pub todo_id: Option<Uuid>,
}

impl ConfirmTodoAction {
    /// Action name.
    pub const NAME: &'static str = "CONFIRM_TODO";

    /// Action description.
    pub const DESCRIPTION: &'static str =
        "Confirms or cancels a pending todo creation after user review.";

    /// Similar action names.
    pub const SIMILES: &'static [&'static str] = &[
        "CONFIRM_TASK",
        "APPROVE_TODO",
        "APPROVE_TASK",
        "TODO_CONFIRM",
    ];

    /// Extract confirmation intent from the user's message.
    pub fn extract_confirmation_intent(message_text: &str) -> ConfirmationResponse {
        let lower_text = message_text.to_lowercase();

        // Check for confirmation keywords
        let confirmation_words = [
            "yes", "yep", "yeah", "sure", "ok", "okay", "confirm", "create", "add", "correct",
            "good", "perfect", "great",
        ];
        let rejection_words = [
            "no",
            "nope",
            "cancel",
            "don't",
            "dont",
            "nevermind",
            "never mind",
            "stop",
        ];

        let has_confirmation = confirmation_words.iter().any(|w| lower_text.contains(w));
        let has_rejection = rejection_words.iter().any(|w| lower_text.contains(w));

        if has_rejection {
            return ConfirmationResponse {
                is_confirmation: true,
                should_proceed: false,
                modifications: None,
            };
        }

        if has_confirmation {
            return ConfirmationResponse {
                is_confirmation: true,
                should_proceed: true,
                modifications: None,
            };
        }

        // Neither confirmation nor rejection
        ConfirmationResponse {
            is_confirmation: false,
            should_proceed: false,
            modifications: None,
        }
    }

    /// Handle the confirm todo action.
    ///
    /// # Arguments
    ///
    /// * `data_service` - The todo data service
    /// * `pending_todo` - The pending todo to confirm
    /// * `message_text` - The user's message text
    /// * `room_id` - The room ID
    /// * `entity_id` - The entity ID
    /// * `agent_id` - The agent ID
    /// * `world_id` - The world ID
    ///
    /// # Returns
    ///
    /// The action result.
    pub async fn handle(
        data_service: Arc<TodoDataService>,
        pending_todo: Option<PendingTodo>,
        message_text: &str,
        room_id: Uuid,
        entity_id: Uuid,
        agent_id: Uuid,
        world_id: Uuid,
    ) -> ConfirmTodoResult {
        info!("Handling CONFIRM_TODO action");

        // Check if there's a pending todo
        let pending = match pending_todo {
            Some(p) => p,
            None => {
                return ConfirmTodoResult {
                    success: false,
                    text: "I don't have a pending task to confirm. Would you like to create a new task?".to_string(),
                    todo_id: None,
                };
            }
        };

        // Extract confirmation intent
        let confirmation = Self::extract_confirmation_intent(message_text);

        if !confirmation.is_confirmation {
            return ConfirmTodoResult {
                success: false,
                text: format!(
                    "I'm still waiting for your confirmation on the task \"{}\". Would you like me to create it?",
                    pending.name
                ),
                todo_id: None,
            };
        }

        if !confirmation.should_proceed {
            return ConfirmTodoResult {
                success: false,
                text: "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task.".to_string(),
                todo_id: None,
            };
        }

        // User confirmed - check for duplicates
        let existing_todos = data_service
            .get_todos(Some(TodoFilters {
                entity_id: Some(entity_id),
                room_id: Some(room_id),
                is_completed: Some(false),
                ..Default::default()
            }))
            .await;

        let duplicate = existing_todos
            .iter()
            .find(|t| t.name.trim().to_lowercase() == pending.name.trim().to_lowercase());

        if duplicate.is_some() {
            return ConfirmTodoResult {
                success: false,
                text: format!(
                    "It looks like you already have an active task named \"{}\". I haven't added a duplicate.",
                    pending.name
                ),
                todo_id: None,
            };
        }

        // Create the task
        let params = CreateTodoParams {
            agent_id,
            world_id,
            room_id,
            entity_id,
            name: pending.name.clone(),
            description: Some(
                pending
                    .description
                    .clone()
                    .unwrap_or_else(|| pending.name.clone()),
            ),
            task_type: pending.task_type,
            priority: if pending.task_type == TaskType::OneOff {
                pending.priority
            } else {
                None
            },
            is_urgent: if pending.task_type == TaskType::OneOff {
                pending.urgent
            } else {
                false
            },
            due_date: pending.due_date,
            tags: pending.tags.clone(),
            metadata: pending.metadata.clone(),
        };

        match data_service.create_todo(params).await {
            Ok(todo_id) => {
                let response_text = match pending.task_type {
                    TaskType::Daily => {
                        format!(
                            "✅ Created daily task: \"{}\". Complete it regularly to build your streak!",
                            pending.name
                        )
                    }
                    TaskType::OneOff => {
                        let priority_text = pending
                            .priority
                            .map(|p| format!("Priority {}", p as u8))
                            .unwrap_or_else(|| "Priority 3".to_string());
                        let urgent_text = if pending.urgent { ", Urgent" } else { "" };
                        let due_date_text = pending
                            .due_date
                            .map(|d| format!(", Due: {}", d.format("%m/%d/%Y")))
                            .unwrap_or_default();
                        format!(
                            "✅ Created task: \"{}\" ({}{}{})",
                            pending.name, priority_text, urgent_text, due_date_text
                        )
                    }
                    TaskType::Aspirational => {
                        format!("✅ Created aspirational goal: \"{}\"", pending.name)
                    }
                };

                ConfirmTodoResult {
                    success: true,
                    text: response_text,
                    todo_id: Some(todo_id),
                }
            }
            Err(e) => {
                error!("Error creating todo: {}", e);
                ConfirmTodoResult {
                    success: false,
                    text: format!("Failed to create todo: {}", e),
                    todo_id: None,
                }
            }
        }
    }

    /// Validate if the confirm todo action can be executed.
    ///
    /// # Arguments
    ///
    /// * `pending_todo` - The pending todo from state
    ///
    /// # Returns
    ///
    /// True if there's a pending todo to confirm.
    pub fn validate(pending_todo: &Option<PendingTodo>) -> bool {
        pending_todo.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_confirmation_yes() {
        let response = ConfirmTodoAction::extract_confirmation_intent("yes, that looks good");
        assert!(response.is_confirmation);
        assert!(response.should_proceed);
    }

    #[test]
    fn test_extract_confirmation_no() {
        let response = ConfirmTodoAction::extract_confirmation_intent("no, cancel it");
        assert!(response.is_confirmation);
        assert!(!response.should_proceed);
    }

    #[test]
    fn test_extract_confirmation_unrelated() {
        let response = ConfirmTodoAction::extract_confirmation_intent("what time is it?");
        assert!(!response.is_confirmation);
        assert!(!response.should_proceed);
    }
}
