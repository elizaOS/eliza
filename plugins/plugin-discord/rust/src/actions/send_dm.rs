//! Send DM action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::{DiscordError, Result};
use crate::types::Snowflake;
use crate::DiscordService;

/// Action to send a direct message to a Discord user
pub struct SendDmAction;

#[async_trait]
impl DiscordAction for SendDmAction {
    fn name(&self) -> &str {
        "SEND_DM"
    }

    fn description(&self) -> &str {
        "Sends a direct message to a Discord user. Use this for private communications."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SEND_DIRECT_MESSAGE",
            "DM_USER",
            "PRIVATE_MESSAGE",
            "PM_USER",
            "WHISPER",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        // Check source is Discord
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if source != "discord" {
            return Ok(false);
        }

        // Check we have a valid target user ID
        let target_id = context
            .message
            .get("content")
            .and_then(|c| c.get("target_user_id"))
            .and_then(|t| t.as_str());

        if let Some(id) = target_id {
            if Snowflake::new(id.to_string()).is_err() {
                return Ok(false);
            }
        } else {
            // If no target, we'll DM the sender
            Snowflake::new(context.user_id.clone())?;
        }

        // Check we have content to send
        let has_content = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .map(|t| !t.as_str().unwrap_or("").is_empty())
            .unwrap_or(false);

        Ok(has_content)
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        // Get target user ID - either specified or the sender
        let target_id = context
            .message
            .get("content")
            .and_then(|c| c.get("target_user_id"))
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| context.user_id.clone());

        let user_id = Snowflake::new(target_id)?;

        let content = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| DiscordError::InvalidArgument("Missing message content".to_string()))?;

        let message_id = service.send_dm(&user_id, content).await?;

        Ok(ActionResult::success_with_data(
            "Direct message sent successfully",
            serde_json::json!({
                "message_id": message_id.as_str(),
                "user_id": user_id.as_str(),
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate_with_target() {
        let action = SendDmAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "Hello!",
                    "target_user_id": "123456789012345678"
                }
            }),
            channel_id: "987654321098765432".to_string(),
            guild_id: None,
            user_id: "111222333444555666".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_without_target() {
        let action = SendDmAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": { "text": "Hello back!" }
            }),
            channel_id: "987654321098765432".to_string(),
            guild_id: None,
            user_id: "123456789012345678".to_string(),
            state: json!({}),
        };

        // Should validate - will DM the sender
        assert!(action.validate(&context).await.unwrap());
    }
}
