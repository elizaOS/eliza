//! Leave channel action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to leave a Discord channel (text or voice)
pub struct LeaveChannelAction;

#[async_trait]
impl DiscordAction for LeaveChannelAction {
    fn name(&self) -> &str {
        "LEAVE_CHANNEL"
    }

    fn description(&self) -> &str {
        "Leave a Discord channel - either stop listening to a text channel or leave a voice channel."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "STOP_LISTENING_CHANNEL",
            "IGNORE_CHANNEL",
            "REMOVE_CHANNEL",
            "UNWATCH_CHANNEL",
            "STOP_MONITORING_CHANNEL",
            "LEAVE_TEXT_CHANNEL",
            "LEAVE_VOICE",
            "LEAVE_VC",
            "LEAVE_VOICE_CHAT",
            "LEAVE_VOICE_CHANNEL",
            "EXIT_VOICE_CHANNEL",
            "DISCONNECT_VOICE",
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

        // Check if this is a voice leave request
        let text_lower = text.to_lowercase();
        let is_voice_request = text_lower.contains("voice")
            || text_lower.contains("vc")
            || text_lower.contains("disconnect");

        // Parse channel info from message
        let channel_info = service.parse_channel_info(text).await?;

        let channel_identifier = channel_info
            .get("channel_identifier")
            .and_then(|c| c.as_str())
            .unwrap_or("");

        // If no specific channel and it's a voice request, leave current voice
        if is_voice_request && channel_identifier.is_empty() {
            let success = service.leave_voice_channel().await?;
            if success {
                return Ok(ActionResult::success_with_data(
                    "I've left the voice channel.",
                    serde_json::json!({"type": "voice"}),
                ));
            } else {
                return Ok(ActionResult::failure(
                    "I'm not currently in a voice channel.",
                ));
            }
        }

        if channel_identifier.is_empty() {
            return Ok(ActionResult::failure(
                "I couldn't understand which channel you want me to leave. \
                 Please specify the channel name or ID.",
            ));
        }

        let is_voice = channel_info
            .get("is_voice_channel")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Find the channel
        let channel = service
            .find_channel(
                channel_identifier,
                context.guild_id.as_deref(),
                is_voice || is_voice_request,
            )
            .await?;

        if channel.is_null() {
            return Ok(ActionResult::failure(format!(
                "I couldn't find a channel with the identifier \"{}\".",
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
            let success = service.leave_voice_channel().await?;
            if success {
                return Ok(ActionResult::success_with_data(
                    format!("I've left the voice channel {}.", channel_name),
                    serde_json::json!({
                        "channel_id": channel_id,
                        "channel_name": channel_name,
                        "type": "voice",
                    }),
                ));
            } else {
                return Ok(ActionResult::failure(
                    "I'm not currently in that voice channel.",
                ));
            }
        }

        // Handle text channels
        let success = service.remove_allowed_channel(channel_id).await?;
        if success {
            Ok(ActionResult::success_with_data(
                format!(
                    "I've stopped listening to {} (<#{}>).",
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
                "I wasn't listening to {}.",
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
        let action = LeaveChannelAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "leave the general channel"
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
