//! Cancel goal action

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, GoalAction};
use crate::error::Result;

/// Action to cancel/delete a goal
pub struct CancelGoalAction;

impl CancelGoalAction {
    /// Check if user wants to cancel a goal based on message text
    pub fn wants_cancel(text: &str) -> bool {
        let lower = text.to_lowercase();
        lower.contains("cancel")
            || lower.contains("delete")
            || lower.contains("remove")
            || lower.contains("stop tracking")
            || (lower.contains("don't") && lower.contains("want"))
    }
}

#[async_trait]
impl GoalAction for CancelGoalAction {
    fn name(&self) -> &'static str {
        "CANCEL_GOAL"
    }

    fn description(&self) -> &'static str {
        "Cancel and delete a goal from tracking"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check if there's a goal_id to cancel
        let has_goal_id = context.state.get("goal_id").is_some();

        // Or check message text for cancel intent
        let message_text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        Ok(has_goal_id || Self::wants_cancel(message_text))
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let goal_id = context
            .state
            .get("goal_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let goal_name = context
            .state
            .get("goal_name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown Goal");

        Ok(serde_json::json!({
            "action": self.name(),
            "success": true,
            "goal_id": goal_id,
            "goal_name": goal_name,
            "message": format!("Cancelled goal: \"{}\"", goal_name)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_with_goal_id() {
        let action = CancelGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "goal_id": "goal-789"
            }),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_with_cancel_intent() {
        let action = CancelGoalAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": { "text": "Cancel my learning goal" }
            }),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_with_delete_intent() {
        let action = CancelGoalAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": { "text": "Delete that goal" }
            }),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_intent() {
        let action = CancelGoalAction;

        let context = ActionContext {
            message: serde_json::json!({
                "content": { "text": "How are you?" }
            }),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute() {
        let action = CancelGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "goal_id": "goal-789",
                "goal_name": "Learn Rust"
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["goal_id"], "goal-789");
        assert!(result["message"].as_str().unwrap().contains("Learn Rust"));
    }

    #[test]
    fn test_wants_cancel() {
        assert!(CancelGoalAction::wants_cancel("cancel my goal"));
        assert!(CancelGoalAction::wants_cancel("delete that task"));
        assert!(CancelGoalAction::wants_cancel("remove the goal"));
        assert!(CancelGoalAction::wants_cancel("stop tracking this"));
        assert!(CancelGoalAction::wants_cancel("I don't want this goal"));
        assert!(!CancelGoalAction::wants_cancel("create a new goal"));
        assert!(!CancelGoalAction::wants_cancel("how are you"));
    }
}
