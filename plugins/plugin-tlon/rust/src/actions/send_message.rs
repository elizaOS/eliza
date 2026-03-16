//! Send message action.

use async_trait::async_trait;
use serde_json::Value;

use super::{ActionContext, TlonAction};
use crate::error::Result;

/// Action that builds a JSON payload for sending a Tlon message.
pub struct SendMessageAction;

#[async_trait]
impl TlonAction for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_TLON_MESSAGE"
    }

    fn description(&self) -> &'static str {
        "Send a message via Tlon/Urbit to a ship or channel"
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context.message.get("source").and_then(|v| v.as_str());
        Ok(source == Some("tlon") || source == Some("urbit"))
    }

    async fn execute(&self, context: &ActionContext) -> Result<Value> {
        let response_text = context
            .state
            .get("response")
            .and_then(|v| v.get("text"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let target = if let Some(ref nest) = context.channel_nest {
            serde_json::json!({ "channel_nest": nest })
        } else if let Some(ref ship) = context.ship {
            serde_json::json!({ "ship": ship })
        } else {
            serde_json::json!({})
        };

        Ok(serde_json::json!({
            "action": self.name(),
            "target": target,
            "text": response_text,
            "reply_to_id": context.reply_to_id
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_tlon_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "tlon",
                "text": "Hello"
            }),
            ship: Some("sampel-palnet".to_string()),
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_urbit_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "urbit",
                "text": "Hello"
            }),
            ship: None,
            channel_nest: Some("chat/~host/channel".to_string()),
            reply_to_id: None,
            state: serde_json::json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_other_source() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "telegram",
                "text": "Hello"
            }),
            ship: None,
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_execute_dm() {
        let action = SendMessageAction;

        let context = ActionContext {
            message: serde_json::json!({
                "source": "tlon"
            }),
            ship: Some("sampel-palnet".to_string()),
            channel_nest: None,
            reply_to_id: None,
            state: serde_json::json!({
                "response": { "text": "Hello from bot!" }
            }),
        };

        let result = action.execute(&context).await.unwrap();
        assert_eq!(result["action"], "SEND_TLON_MESSAGE");
        assert_eq!(result["target"]["ship"], "sampel-palnet");
        assert_eq!(result["text"], "Hello from bot!");
    }
}
