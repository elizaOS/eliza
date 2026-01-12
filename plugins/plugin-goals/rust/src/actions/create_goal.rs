//! Create goal action

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, GoalAction};
use crate::error::Result;

/// Action to create a new goal
pub struct CreateGoalAction;

#[async_trait]
impl GoalAction for CreateGoalAction {
    fn name(&self) -> &'static str {
        "CREATE_GOAL"
    }

    fn description(&self) -> &'static str {
        "Create a new goal for tracking"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check if there's goal information in the state
        let has_goal_info = context
            .state
            .get("extracted_goal")
            .map(|v| v.get("name").is_some())
            .unwrap_or(false);
        Ok(has_goal_info)
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let extracted = context.state.get("extracted_goal");
        let name = extracted
            .and_then(|e| e.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unnamed Goal");

        let description = extracted
            .and_then(|e| e.get("description"))
            .and_then(|v| v.as_str());

        Ok(serde_json::json!({
            "action": self.name(),
            "goal": {
                "agent_id": context.agent_id,
                "owner_id": context.entity_id,
                "owner_type": "entity",
                "name": name,
                "description": description
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_with_goal_info() {
        let action = CreateGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "extracted_goal": {
                    "name": "Learn Rust"
                }
            }),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_goal_info() {
        let action = CreateGoalAction;

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
    async fn test_execute() {
        let action = CreateGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "extracted_goal": {
                    "name": "Learn Rust",
                    "description": "Master the Rust programming language"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["goal"]["name"], "Learn Rust");
    }
}
