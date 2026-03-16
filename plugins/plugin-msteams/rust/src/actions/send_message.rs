//! Send message actions for MS Teams.

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, MSTeamsAction};
use crate::error::Result;

/// Action that sends a message to an MS Teams conversation.
pub struct SendMessageAction;

#[async_trait]
impl MSTeamsAction for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_MSTEAMS_MESSAGE"
    }

    fn description(&self) -> &'static str {
        "Send a message to a Microsoft Teams conversation"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("msteams"))
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let response_text = context
            .state
            .get("response")
            .and_then(|v| v.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        Ok(serde_json::json!({
            "action": self.name(),
            "conversationId": context.conversation_id,
            "text": response_text,
            "replyToId": context.message.get("activityId")
        }))
    }
}

/// Action that sends a poll to an MS Teams conversation.
pub struct SendPollAction;

#[async_trait]
impl MSTeamsAction for SendPollAction {
    fn name(&self) -> &'static str {
        "SEND_MSTEAMS_POLL"
    }

    fn description(&self) -> &'static str {
        "Send a poll to a Microsoft Teams conversation"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("msteams"))
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let question = context
            .state
            .get("pollQuestion")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let options = context
            .state
            .get("pollOptions")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let max_selections = context
            .state
            .get("maxSelections")
            .and_then(|v| v.as_u64())
            .unwrap_or(1) as u32;

        Ok(serde_json::json!({
            "action": self.name(),
            "conversationId": context.conversation_id,
            "question": question,
            "options": options,
            "maxSelections": max_selections
        }))
    }
}

/// Action that sends an Adaptive Card to an MS Teams conversation.
pub struct SendAdaptiveCardAction;

#[async_trait]
impl MSTeamsAction for SendAdaptiveCardAction {
    fn name(&self) -> &'static str {
        "SEND_MSTEAMS_CARD"
    }

    fn description(&self) -> &'static str {
        "Send an Adaptive Card to a Microsoft Teams conversation"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("msteams"))
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let card = context
            .state
            .get("cardContent")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        let fallback_text = context
            .state
            .get("fallbackText")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        Ok(serde_json::json!({
            "action": self.name(),
            "conversationId": context.conversation_id,
            "card": card,
            "fallbackText": fallback_text
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_msteams_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "msteams",
                "text": "Hello"
            }),
            conversation_id: "conv-123".to_string(),
            user_id: "user-456".to_string(),
            tenant_id: Some("tenant-789".to_string()),
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_msteams_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "discord",
                "text": "Hello"
            }),
            conversation_id: "conv-123".to_string(),
            user_id: "user-456".to_string(),
            tenant_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_send_poll_action() {
        let action = SendPollAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "msteams"
            }),
            conversation_id: "conv-123".to_string(),
            user_id: "user-456".to_string(),
            tenant_id: None,
            state: serde_json::json!({
                "pollQuestion": "What's your favorite color?",
                "pollOptions": ["Red", "Blue", "Green"],
                "maxSelections": 1
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_MSTEAMS_POLL");
        assert_eq!(result["question"], "What's your favorite color?");
    }
}
