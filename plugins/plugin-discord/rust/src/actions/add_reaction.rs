//! Add reaction action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::{DiscordError, Result};
use crate::types::Snowflake;
use crate::DiscordService;

/// Action to add a reaction to a Discord message
pub struct AddReactionAction;

#[async_trait]
impl DiscordAction for AddReactionAction {
    fn name(&self) -> &str {
        "ADD_REACTION"
    }

    fn description(&self) -> &str {
        "Adds an emoji reaction to a Discord message. Use this to express emotions or provide quick feedback."
    }

    fn similes(&self) -> Vec<&str> {
        vec!["REACT", "ADD_EMOJI", "EMOJI_REACTION", "REACT_TO_MESSAGE"]
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

        // Check we have a valid channel ID
        Snowflake::new(context.channel_id.clone())?;

        // Check we have a message ID to react to
        let has_message_id = context
            .message
            .get("content")
            .and_then(|c| c.get("message_id"))
            .and_then(|m| m.as_str())
            .map(|id| Snowflake::new(id.to_string()).is_ok())
            .unwrap_or(false);

        // Check we have an emoji
        let has_emoji = context
            .message
            .get("content")
            .and_then(|c| c.get("emoji"))
            .map(|e| !e.as_str().unwrap_or("").is_empty())
            .unwrap_or(false);

        Ok(has_message_id && has_emoji)
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        let channel_id = Snowflake::new(context.channel_id.clone())?;

        let message_id_str = context
            .message
            .get("content")
            .and_then(|c| c.get("message_id"))
            .and_then(|m| m.as_str())
            .ok_or_else(|| DiscordError::InvalidArgument("Missing message_id".to_string()))?;

        let message_id = Snowflake::new(message_id_str.to_string())?;

        let emoji = context
            .message
            .get("content")
            .and_then(|c| c.get("emoji"))
            .and_then(|e| e.as_str())
            .ok_or_else(|| DiscordError::InvalidArgument("Missing emoji".to_string()))?;

        service
            .add_reaction(&channel_id, &message_id, emoji)
            .await?;

        Ok(ActionResult::success_with_data(
            "Reaction added successfully",
            serde_json::json!({
                "channel_id": channel_id.as_str(),
                "message_id": message_id.as_str(),
                "emoji": emoji,
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
        let action = AddReactionAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "message_id": "123456789012345678",
                    "emoji": "👍"
                }
            }),
            channel_id: "987654321098765432".to_string(),
            guild_id: Some("111222333444555666".to_string()),
            user_id: "999888777666555444".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }

    #[tokio::test]
    async fn test_validate_missing_emoji() {
        let action = AddReactionAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "message_id": "123456789012345678"
                }
            }),
            channel_id: "987654321098765432".to_string(),
            guild_id: None,
            user_id: "999888777666555444".to_string(),
            state: json!({}),
        };

        assert!(!action.validate(&context).await.unwrap());
    }
}
