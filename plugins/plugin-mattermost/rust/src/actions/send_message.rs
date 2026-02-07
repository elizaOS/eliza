use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, MattermostAction};
use crate::error::Result;

/// Action that builds a JSON payload for sending a Mattermost message.
pub struct SendMessageAction;

#[async_trait]
impl MattermostAction for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_MATTERMOST_MESSAGE"
    }

    fn description(&self) -> &'static str {
        "Send a message to a Mattermost channel or user"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("mattermost"))
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
            "channel_id": context.channel_id,
            "text": response_text,
            "root_id": context.root_id,
            "reply_to_post_id": context.message.get("post_id")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_mattermost_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "mattermost",
                "text": "Hello"
            }),
            channel_id: "channel123".to_string(),
            user_id: "user456".to_string(),
            root_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_mattermost_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "discord",
                "text": "Hello"
            }),
            channel_id: "channel123".to_string(),
            user_id: "user456".to_string(),
            root_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute_with_response() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "mattermost",
                "post_id": "post789"
            }),
            channel_id: "channel123".to_string(),
            user_id: "user456".to_string(),
            root_id: Some("root123".to_string()),
            state: serde_json::json!({
                "response": {
                    "text": "Hello, world!"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_MATTERMOST_MESSAGE");
        assert_eq!(result["channel_id"], "channel123");
        assert_eq!(result["text"], "Hello, world!");
        assert_eq!(result["root_id"], "root123");
    }
}
