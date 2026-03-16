//! Send DM action for Instagram

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, InstagramAction};
use crate::error::Result;

/// Action to send a direct message on Instagram
pub struct SendDmAction;

#[async_trait]
impl InstagramAction for SendDmAction {
    fn name(&self) -> &'static str {
        "SEND_INSTAGRAM_DM"
    }

    fn description(&self) -> &'static str {
        "Send a direct message to an Instagram user"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check if this is an Instagram message with a thread ID
        let source = context.message.get("source").and_then(|v| v.as_str());
        let has_thread = context.thread_id.is_some();
        Ok(source == Some("instagram") && has_thread)
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
            "thread_id": context.thread_id,
            "text": response_text
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_instagram_source() {
        let action = SendDmAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "instagram",
                "text": "Hello"
            }),
            user_id: 12345,
            thread_id: Some("thread-1".to_string()),
            media_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_instagram_source() {
        let action = SendDmAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "telegram",
                "text": "Hello"
            }),
            user_id: 12345,
            thread_id: Some("thread-1".to_string()),
            media_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_no_thread() {
        let action = SendDmAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "instagram",
                "text": "Hello"
            }),
            user_id: 12345,
            thread_id: None,
            media_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }
}
