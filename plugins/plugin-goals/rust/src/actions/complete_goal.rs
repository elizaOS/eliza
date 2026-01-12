//! Complete goal action

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, GoalAction};
use crate::error::Result;

/// Action to complete a goal
pub struct CompleteGoalAction;

#[async_trait]
impl GoalAction for CompleteGoalAction {
    fn name(&self) -> &'static str {
        "COMPLETE_GOAL"
    }

    fn description(&self) -> &'static str {
        "Mark a goal as completed"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check if there's a goal selection in the state
        let has_selection = context
            .state
            .get("goal_selection")
            .map(|v| v.get("goal_id").is_some())
            .unwrap_or(false);
        Ok(has_selection)
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let selection = context.state.get("goal_selection");
        let goal_id = selection
            .and_then(|s| s.get("goal_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        Ok(serde_json::json!({
            "action": self.name(),
            "goal_id": goal_id,
            "completed": true
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_with_selection() {
        let action = CompleteGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "goal_selection": {
                    "goal_id": "goal-789"
                }
            }),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_selection() {
        let action = CompleteGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }
}
