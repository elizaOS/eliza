//! Read channel action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to read recent messages from a Discord channel
pub struct ReadChannelAction;

#[async_trait]
impl DiscordAction for ReadChannelAction {
    fn name(&self) -> &str {
        "READ_CHANNEL"
    }

    fn description(&self) -> &str {
        "Read recent messages from a Discord channel to understand the conversation context."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "GET_MESSAGES",
            "FETCH_MESSAGES",
            "READ_MESSAGES",
            "CHANNEL_HISTORY",
            "GET_CHANNEL_MESSAGES",
            "SHOW_MESSAGES",
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

        // Parse channel and limit from message
        let read_info = service.parse_read_channel_info(text).await?;

        let mut channel_id = context.channel_id.clone();
        let mut limit: u32 = 10; // Default

        if !read_info.is_null() {
            if let Some(identifier) = read_info.get("channel_identifier").and_then(|c| c.as_str()) {
                // Find the specified channel
                let channel = service
                    .find_channel(identifier, context.guild_id.as_deref(), false)
                    .await?;
                if !channel.is_null() {
                    if let Some(id) = channel.get("id").and_then(|i| i.as_str()) {
                        channel_id = id.to_string();
                    }
                }
            }

            if let Some(l) = read_info.get("limit").and_then(|l| l.as_u64()) {
                limit = l.clamp(1, 100) as u32;
            }
        }

        // Fetch messages
        let messages = service.fetch_channel_messages(&channel_id, limit).await?;

        if messages.is_empty() {
            return Ok(ActionResult::failure(
                "I couldn't fetch messages from this channel. \
                 I might not have permission to read message history.",
            ));
        }

        // Format messages
        let mut formatted_messages = Vec::new();
        for msg in &messages {
            let author = msg
                .get("author")
                .and_then(|a| a.as_str())
                .unwrap_or("Unknown");
            let content = msg.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let timestamp = msg.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
            formatted_messages.push(format!("**{}** ({}):\n{}", author, timestamp, content));
        }

        let response_text = format!(
            "Here are the last {} messages:\n\n{}",
            messages.len(),
            formatted_messages.join("\n\n")
        );

        Ok(ActionResult::success_with_data(
            response_text,
            serde_json::json!({
                "channel_id": channel_id,
                "message_count": messages.len(),
                "messages": messages,
            }),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_validate() {
        let action = ReadChannelAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "show me the last 20 messages"
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
