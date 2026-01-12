//! Goals state provider

use async_trait::async_trait;
use serde_json::Value;

use super::{GoalProvider, ProviderContext};

/// Provider for goals state
pub struct GoalsStateProvider;

#[async_trait]
impl GoalProvider for GoalsStateProvider {
    fn name(&self) -> &'static str {
        "goals_state"
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        serde_json::json!({
            "agent_id": context.agent_id,
            "entity_id": context.entity_id,
            "room_id": context.room_id,
            "has_context": context.agent_id.is_some() || context.entity_id.is_some()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_goals_state() {
        let provider = GoalsStateProvider;
        let context = ProviderContext {
            agent_id: Some("agent-123".to_string()),
            entity_id: Some("user-456".to_string()),
            room_id: Some("room-789".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["agent_id"], "agent-123");
        assert_eq!(state["entity_id"], "user-456");
        assert_eq!(state["has_context"], true);
    }

    #[tokio::test]
    async fn test_goals_state_empty() {
        let provider = GoalsStateProvider;
        let context = ProviderContext {
            agent_id: None,
            entity_id: None,
            room_id: None,
        };

        let state = provider.get(&context).await;
        assert_eq!(state["has_context"], false);
    }
}
