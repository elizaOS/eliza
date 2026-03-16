//! Join channel action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to join a Discord channel (text or voice)
pub struct JoinChannelAction;

#[async_trait]
impl DiscordAction for JoinChannelAction {
    fn name(&self) -> &str {
        "JOIN_CHANNEL"
    }

    fn description(&self) -> &str {
        "Join a Discord channel - either text (to monitor messages) or voice (to participate in voice chat)."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "START_LISTENING_CHANNEL",
            "LISTEN_TO_CHANNEL",
            "ADD_CHANNEL",
            "WATCH_CHANNEL",
            "MONITOR_CHANNEL",
            "JOIN_TEXT_CHANNEL",
            "JOIN_VOICE",
            "JOIN_VC",
            "JOIN_VOICE_CHAT",
            "JOIN_VOICE_CHANNEL",
            "HOP_IN_VOICE",
            "ENTER_VOICE_CHANNEL",
        ]
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
        let text = context
            .message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Parse channel info from message
        let channel_info = service.parse_channel_info(text).await?;

        let channel_identifier = channel_info
            .get("channel_identifier")
            .and_then(|c| c.as_str())
            .unwrap_or("");

        if channel_identifier.is_empty() {
            return Ok(ActionResult::failure(
                "I couldn't understand which channel you want me to join. \
                 Please specify the channel name or ID.",
            ));
        }

        let is_voice = channel_info
            .get("is_voice_channel")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Check if this is a voice request based on message content
        let text_lower = text.to_lowercase();
        let is_voice_request = is_voice
            || text_lower.contains("voice")
            || text_lower.contains("vc")
            || text_lower.contains("hop in");

        // Find the channel
        let channel = service
            .find_channel(
                channel_identifier,
                context.guild_id.as_deref(),
                is_voice_request,
            )
            .await?;

        // Try opposite type if not found
        let channel = if channel.is_null() {
            service
                .find_channel(
                    channel_identifier,
                    context.guild_id.as_deref(),
                    !is_voice_request,
                )
                .await?
        } else {
            channel
        };

        if channel.is_null() {
            return Ok(ActionResult::failure(format!(
                "I couldn't find a channel with the identifier \"{}\". \
                 Please make sure the channel name or ID is correct.",
                channel_identifier
            )));
        }

        let channel_name = channel
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("Unknown");
        let channel_id = channel.get("id").and_then(|i| i.as_str()).unwrap_or("");
        let channel_type = channel
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("text");

        // Handle voice channels
        if channel_type == "voice" {
            let success = service.join_voice_channel(channel_id).await?;
            if success {
                return Ok(ActionResult::success_with_data(
                    format!("I've joined the voice channel {}!", channel_name),
                    serde_json::json!({
                        "channel_id": channel_id,
                        "channel_name": channel_name,
                        "type": "voice",
                    }),
                ));
            } else {
                return Ok(ActionResult::failure(
                    "Voice functionality is not available at the moment.",
                ));
            }
        }

        // Handle text channels
        let success = service.add_allowed_channel(channel_id).await?;
        if success {
            Ok(ActionResult::success_with_data(
                format!(
                    "I've started listening to {} (<#{}>). I'll now respond to messages in that channel.",
                    channel_name, channel_id
                ),
                serde_json::json!({
                    "channel_id": channel_id,
                    "channel_name": channel_name,
                    "type": "text",
                }),
            ))
        } else {
            Ok(ActionResult::failure(format!(
                "I couldn't add {} to my listening list.",
                channel_name
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate() {
        let action = JoinChannelAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "join the general channel"
                }
            }),
            channel_id: "123456789".to_string(),
            guild_id: Some("987654321".to_string()),
            user_id: "111222333".to_string(),
            state: json!({}),
        };

        assert!(action.validate(&context).await.unwrap());
    }
}
