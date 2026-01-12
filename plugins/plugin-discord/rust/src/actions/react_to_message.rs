//! React to message action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::types::Snowflake;
use crate::DiscordService;

/// Action to add an emoji reaction to a specific message
pub struct ReactToMessageAction;

#[async_trait]
impl DiscordAction for ReactToMessageAction {
    fn name(&self) -> &str {
        "REACT_TO_MESSAGE"
    }

    fn description(&self) -> &str {
        "Add an emoji reaction to a specific message in Discord."
    }

    fn similes(&self) -> Vec<&str> {
        vec!["ADD_REACTION_TO", "REACT_MESSAGE", "EMOJI_REACT"]
    }

    async fn validate(&self, context: &ActionContext) -> Result<bool> {
        let source = context
            .message
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        Ok(source == "discord")
    }

    async fn handler(
        &self,
        context: &ActionContext,
        service: &DiscordService,
    ) -> Result<ActionResult> {
        let channel_id = Snowflake::new(context.channel_id.clone())?;

        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Extract emoji and message reference
        let reaction_info = service.extract_reaction_info(text).await?;

        let reaction_info = match reaction_info {
            Some(info) => info,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't understand what emoji to use or which message to react to.",
                ))
            }
        };

        let emoji = reaction_info
            .get("emoji")
            .and_then(|e| e.as_str())
            .unwrap_or("");
        let message_ref = reaction_info
            .get("message_ref")
            .and_then(|m| m.as_str())
            .unwrap_or("last");

        // Find the target message
        let target_message = service.find_message(&channel_id, message_ref).await?;

        let target_message = match target_message {
            Some(msg) => msg,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't find the message to react to.",
                ))
            }
        };

        let message_id_str = target_message
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("");

        // Parse message ID as Snowflake
        let message_id = match Snowflake::new(message_id_str.to_string()) {
            Ok(id) => id,
            Err(_) => {
                return Ok(ActionResult::failure(
                    "I couldn't find a valid message to react to.",
                ));
            }
        };

        // Add reaction
        if service
            .add_reaction(&channel_id, &message_id, emoji)
            .await
            .is_err()
        {
            return Ok(ActionResult::failure(
                "I couldn't add the reaction. The emoji might be invalid \
                or I might not have permission.",
            ));
        }

        Ok(ActionResult::success_with_data(
            format!("I've added {} to the message.", emoji),
            serde_json::json!({
                "message_id": message_id_str,
                "emoji": emoji,
            }),
        ))
    }
}
