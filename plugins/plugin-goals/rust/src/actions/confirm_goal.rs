//! Confirm goal action

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, GoalAction};
use crate::error::Result;

/// Action to confirm or cancel a pending goal creation
pub struct ConfirmGoalAction;

impl ConfirmGoalAction {
    /// Check if user wants to confirm based on message text
    pub fn is_confirmation(text: &str) -> (bool, bool) {
        let lower = text.to_lowercase();

        // Check for positive confirmation
        let confirms = lower.contains("yes")
            || lower.contains("correct")
            || lower.contains("confirm")
            || lower.contains("approve")
            || lower.contains("looks good")
            || lower.contains("that's right");

        // Check for cancellation
        let cancels = lower.contains("no")
            || lower.contains("cancel")
            || lower.contains("nevermind")
            || lower.contains("stop")
            || lower.contains("don't");

        if confirms {
            (true, true) // is_confirmation, should_proceed
        } else if cancels {
            (true, false) // is_confirmation, should_not_proceed
        } else {
            (false, false) // not a confirmation response
        }
    }
}

#[async_trait]
impl GoalAction for ConfirmGoalAction {
    fn name(&self) -> &'static str {
        "CONFIRM_GOAL"
    }

    fn description(&self) -> &'static str {
        "Confirms or cancels a pending goal creation after user review"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // This action is only valid if there's a pending goal in the state
        let has_pending = context.state.get("pendingGoal").is_some();
        Ok(has_pending)
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        // Get pending goal from state
        let pending_goal = context.state.get("pendingGoal");

        if pending_goal.is_none() {
            return Ok(serde_json::json!({
                "action": self.name(),
                "success": false,
                "error": "No pending goal to confirm",
                "message": "I don't have a pending task to confirm. Would you like to create a new task?"
            }));
        }

        let pending = pending_goal.unwrap();
        let goal_name = pending
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let task_type = pending
            .get("taskType")
            .and_then(|v| v.as_str())
            .unwrap_or("one-off");
        let priority = pending
            .get("priority")
            .and_then(|v| v.as_i64())
            .unwrap_or(3);
        let due_date = pending.get("dueDate").and_then(|v| v.as_str());
        let urgent = pending
            .get("urgent")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Get message text to check confirmation intent
        let message_text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let (is_confirmation, should_proceed) = Self::is_confirmation(message_text);

        if !is_confirmation {
            return Ok(serde_json::json!({
                "action": self.name(),
                "success": true,
                "waiting": true,
                "message": format!("I'm still waiting for your confirmation on the task \"{}\". Would you like me to create it?", goal_name)
            }));
        }

        if !should_proceed {
            return Ok(serde_json::json!({
                "action": self.name(),
                "success": true,
                "cancelled": true,
                "message": "Okay, I've cancelled the task creation. Let me know if you'd like to create a different task."
            }));
        }

        // Build success message based on task type
        let success_message = match task_type {
            "daily" => format!("✅ Created daily task: \"{}\".", goal_name),
            "aspirational" => format!("✅ Created aspirational goal: \"{}\"", goal_name),
            _ => {
                let priority_text = format!("Priority {}", priority);
                let urgent_text = if urgent { ", Urgent" } else { "" };
                let due_date_text = due_date
                    .map(|d| format!(", Due: {}", d))
                    .unwrap_or_default();
                format!(
                    "✅ Created task: \"{}\" ({}{}{})",
                    goal_name, priority_text, urgent_text, due_date_text
                )
            }
        };

        Ok(serde_json::json!({
            "action": self.name(),
            "success": true,
            "confirmed": true,
            "goal_name": goal_name,
            "task_type": task_type,
            "message": success_message
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_confirmation_yes() {
        let (is_conf, proceed) = ConfirmGoalAction::is_confirmation("Yes, that looks good");
        assert!(is_conf);
        assert!(proceed);
    }

    #[test]
    fn test_is_confirmation_no() {
        let (is_conf, proceed) = ConfirmGoalAction::is_confirmation("No, cancel that");
        assert!(is_conf);
        assert!(!proceed);
    }

    #[test]
    fn test_is_confirmation_unrelated() {
        let (is_conf, proceed) = ConfirmGoalAction::is_confirmation("What's the weather like?");
        assert!(!is_conf);
        assert!(!proceed);
    }

    #[tokio::test]
    async fn test_validate_with_pending_goal() {
        let action = ConfirmGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "pendingGoal": {
                    "name": "Learn Rust",
                    "taskType": "one-off"
                }
            }),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_pending_goal() {
        let action = ConfirmGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute_confirm() {
        let action = ConfirmGoalAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": { "text": "Yes, that looks good" }
            }),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "pendingGoal": {
                    "name": "Learn Rust",
                    "taskType": "one-off",
                    "priority": 2
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["confirmed"], true);
        assert!(result["message"].as_str().unwrap().contains("Learn Rust"));
    }

    #[tokio::test]
    async fn test_execute_cancel() {
        let action = ConfirmGoalAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": { "text": "No, cancel that" }
            }),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "pendingGoal": {
                    "name": "Learn Rust",
                    "taskType": "one-off"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["cancelled"], true);
    }
}
