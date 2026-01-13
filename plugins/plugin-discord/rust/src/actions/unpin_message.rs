//! Unpin message action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::types::Snowflake;
use crate::DiscordService;

/// Action to unpin a message in a Discord channel
pub struct UnpinMessageAction;

#[async_trait]
impl DiscordAction for UnpinMessageAction {
    fn name(&self) -> &str {
        "UNPIN_MESSAGE"
    }

    fn description(&self) -> &str {
        "Unpin a previously pinned message in a Discord channel."
    }

    fn similes(&self) -> Vec<&str> {
        vec!["UNPIN_MSG", "REMOVE_PIN", "UNPIN_THAT"]
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

        // Parse message reference
        let message_ref = service.extract_message_reference(text).await?;

        let message_ref = match message_ref {
            Some(r) => r,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't understand which message you want to unpin. \
                    Please be more specific.",
                ))
            }
        };

        // Check permissions
        if !service.has_manage_messages_permission(&channel_id).await {
            return Ok(ActionResult::failure(
                "I don't have permission to unpin messages in this channel. \
                I need the 'Manage Messages' permission.",
            ));
        }

        // Find the message
        let target_message = service.find_message(&channel_id, &message_ref).await?;

        let target_message = match target_message {
            Some(msg) => msg,
            None => {
                return Ok(ActionResult::failure(
                    "I couldn't find the message you want to unpin.",
                ))
            }
        };

        // Check if pinned
        let is_pinned = target_message
            .get("pinned")
            .and_then(|p| p.as_bool())
            .unwrap_or(false);
        if !is_pinned {
            return Ok(ActionResult::failure("That message is not pinned."));
        }

        let message_id = target_message
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("");

        // Unpin the message
        let success = service.unpin_message(&channel_id, message_id).await?;
        if !success {
            return Ok(ActionResult::failure(
                "I couldn't unpin that message. Please try again.",
            ));
        }

        let author = target_message
            .get("author")
            .and_then(|a| a.get("username"))
            .and_then(|u| u.as_str())
            .unwrap_or("unknown");

        Ok(ActionResult::success_with_data(
            format!("I've unpinned the message from {}.", author),
            serde_json::json!({
                "message_id": message_id,
                "author": author,
            }),
        ))
    }
}
