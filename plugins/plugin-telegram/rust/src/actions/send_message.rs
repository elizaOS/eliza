use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, TelegramAction};
use crate::error::Result;

/// Action that builds a JSON payload for sending a Telegram message.
pub struct SendMessageAction;

#[async_trait]
impl TelegramAction for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_TELEGRAM_MESSAGE"
    }

    fn description(&self) -> &'static str {
        "Send a message to a Telegram chat"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("telegram"))
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
    async fn test_validate_telegram_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "telegram",
                "text": "Hello"
            }),
            chat_id: 12345,
            user_id: 67890,
            thread_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_telegram_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "discord",
                "text": "Hello"
            }),
            chat_id: 12345,
            user_id: 67890,
            thread_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }
}
