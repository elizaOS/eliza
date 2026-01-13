use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::{DiscordError, Result};
use crate::types::Snowflake;
use crate::DiscordService;

/// Action that sends a message to a Discord channel.
pub struct SendMessageAction;

#[async_trait]
impl DiscordAction for SendMessageAction {
    fn name(&self) -> &str {
        "SEND_MESSAGE"
    }

    fn description(&self) -> &str {
        "Sends a message to a Discord channel. Use this to respond to users or post content in a channel."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SEND_DISCORD_MESSAGE",
            "POST_MESSAGE",
            "REPLY",
            "RESPOND",
            "SAY",
            "CHAT",
        ]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if source != "discord" {
            return Ok(false);
        }

        Snowflake::new(context.channel_id.clone())?;

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
        let channel_id = Snowflake::new(context.channel_id.clone())?;

        let content = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .ok_or_else(|| DiscordError::InvalidArgument("Missing message content".to_string()))?;

        let message_id = service.send_message(&channel_id, content).await?;

        Ok(ActionResult::success_with_data(
            "Message sent successfully",
            serde_json::json!({
                "message_id": message_id.as_str(),
                "channel_id": channel_id.as_str(),
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate_valid() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": { "text": "Hello, world!" }
            }),
            channel_id: "123456789012345678".to_string(),
            guild_id: Some("987654321098765432".to_string()),
            user_id: "111222333444555666".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_invalid_source() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: json!({
                "source": "telegram",
                "content": { "text": "Hello" }
            }),
            channel_id: "123456789012345678".to_string(),
            guild_id: None,
            user_id: "111222333444555666".to_string(),
            state: json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_missing_content() {
        let action = SendMessageAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
            }),
            channel_id: "123456789012345678".to_string(),
            guild_id: None,
            user_id: "111222333444555666".to_string(),
            state: json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }
}
