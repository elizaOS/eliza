//! Send message action implementation.

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, ZaloAction};
use crate::error::Result;

/// Action that builds a JSON payload for sending a Zalo message.
pub struct SendMessageAction;

#[async_trait]
impl ZaloAction for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_ZALO_MESSAGE"
    }

    fn description(&self) -> &'static str {
        "Send a message to a Zalo user"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("zalo"))
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
            "user_id": context.user_id,
            "text": response_text,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_zalo_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "zalo",
                "text": "Hello"
            }),
            user_id: "12345".to_string(),
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_zalo_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "telegram",
                "text": "Hello"
            }),
            user_id: "12345".to_string(),
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "zalo",
                "text": "Hello"
            }),
            user_id: "12345".to_string(),
            state: serde_json::json!({
                "response": {
                    "text": "Hello from bot!"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_ZALO_MESSAGE");
        assert_eq!(result["user_id"], "12345");
        assert_eq!(result["text"], "Hello from bot!");
    }
}
