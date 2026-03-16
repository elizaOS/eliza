use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, NextcloudTalkAction};
use crate::error::Result;

/// Action that builds a JSON payload for sending a Nextcloud Talk message.
pub struct SendMessageAction;

#[async_trait]
impl NextcloudTalkAction for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_NEXTCLOUD_TALK_MESSAGE"
    }

    fn description(&self) -> &'static str {
        "Send a message to a Nextcloud Talk room"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("nextcloud-talk"))
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
            "room_token": context.room_token,
            "text": response_text,
            "reply_to_message_id": context.message.get("message_id")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_nextcloud_talk_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "nextcloud-talk",
                "text": "Hello"
            }),
            room_token: "abc123".to_string(),
            user_id: "user1".to_string(),
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_non_nextcloud_talk_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "telegram",
                "text": "Hello"
            }),
            room_token: "abc123".to_string(),
            user_id: "user1".to_string(),
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "nextcloud-talk",
                "message_id": "12345"
            }),
            room_token: "room123".to_string(),
            user_id: "user1".to_string(),
            state: serde_json::json!({
                "response": {
                    "text": "Hello, world!"
                }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_NEXTCLOUD_TALK_MESSAGE");
        assert_eq!(result["room_token"], "room123");
        assert_eq!(result["text"], "Hello, world!");
    }
}
