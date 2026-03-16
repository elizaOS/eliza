//! Update goal action

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, GoalAction};
use crate::error::Result;

/// Action to update an existing goal
pub struct UpdateGoalAction;

impl UpdateGoalAction {
    /// Extract goal update information from state
    pub fn extract_update(state: &Value) -> Option<(String, Option<String>, Option<String>)> {
        let goal_id = state.get("goal_id")?.as_str()?.to_string();
        let new_name = state
            .get("new_name")
            .and_then(|v| v.as_str())
            .map(String::from);
        let new_description = state
            .get("new_description")
            .and_then(|v| v.as_str())
            .map(String::from);

        Some((goal_id, new_name, new_description))
    }
}

#[async_trait]
impl GoalAction for UpdateGoalAction {
    fn name(&self) -> &'static str {
        "UPDATE_GOAL"
    }

    fn description(&self) -> &'static str {
        "Update an existing goal's name or description"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check if there's a goal_id and at least one update field
        let has_goal_id = context.state.get("goal_id").is_some();
        let has_update = context.state.get("new_name").is_some()
            || context.state.get("new_description").is_some();

        Ok(has_goal_id && has_update)
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let (goal_id, new_name, new_description) =
            Self::extract_update(&context.state).unwrap_or_default();

        let mut updates = serde_json::Map::new();
        if let Some(name) = &new_name {
            updates.insert("name".to_string(), Value::String(name.clone()));
        }
        if let Some(desc) = &new_description {
            updates.insert("description".to_string(), Value::String(desc.clone()));
        }

        Ok(serde_json::json!({
            "action": self.name(),
            "success": true,
            "goal_id": goal_id,
            "updates": updates,
            "message": format!(
                "Goal updated: {}",
                new_name.unwrap_or_else(|| "description changed".to_string())
            )
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_with_goal_id_and_update() {
        let action = UpdateGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "goal_id": "goal-789",
                "new_name": "Learn Rust Advanced"
            }),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_goal_id() {
        let action = UpdateGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "new_name": "Learn Rust Advanced"
            }),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_updates() {
        let action = UpdateGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "goal_id": "goal-789"
            }),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute_with_name_update() {
        let action = UpdateGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "goal_id": "goal-789",
                "new_name": "Learn Rust Advanced"
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["goal_id"], "goal-789");
        assert_eq!(result["updates"]["name"], "Learn Rust Advanced");
    }

    #[tokio::test]
    async fn test_execute_with_description_update() {
        let action = UpdateGoalAction;

        let context = ActionContext {
            message: serde_json::json!({}),
            agent_id: "agent-123".to_string(),
            entity_id: "user-456".to_string(),
            room_id: None,
            state: serde_json::json!({
                "goal_id": "goal-789",
                "new_description": "Master async Rust programming"
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(
            result["updates"]["description"],
            "Master async Rust programming"
        );
    }
}
