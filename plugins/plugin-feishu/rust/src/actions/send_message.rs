use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, FeishuAction};
use crate::error::Result;

/// Action that builds a JSON payload for sending a Feishu message.
pub struct SendMessageAction;

#[async_trait]
impl FeishuAction for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_FEISHU_MESSAGE"
    }

    fn description(&self) -> &'static str {
        "Send a message to a Feishu/Lark chat"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("feishu"))
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
            "chat_id": context.chat_id,
            "text": response_text,
            "reply_to_message_id": context.message.get("message_id")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_feishu_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "feishu",
                "text": "Hello"
            }),
            chat_id: "oc_test123".to_string(),
            user_id: "ou_test456".to_string(),
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_feishu_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "telegram",
                "text": "Hello"
            }),
            chat_id: "oc_test123".to_string(),
            user_id: "ou_test456".to_string(),
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "feishu",
                "message_id": "msg_123"
            }),
            chat_id: "oc_test123".to_string(),
            user_id: "ou_test456".to_string(),
            state: serde_json::json!({
                "response": {
                    "text": "Hello, World!"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_FEISHU_MESSAGE");
        assert_eq!(result["chat_id"], "oc_test123");
        assert_eq!(result["text"], "Hello, World!");
    }
}
