//! Summarize conversation action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to summarize recent conversation in a Discord channel
pub struct SummarizeConversationAction;

#[async_trait]
impl DiscordAction for SummarizeConversationAction {
    fn name(&self) -> &str {
        "SUMMARIZE_CONVERSATION"
    }

    fn description(&self) -> &str {
        "Generate a summary of the recent conversation in a Discord channel."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "SUMMARIZE_CHAT",
            "CONVERSATION_SUMMARY",
            "RECAP_CHAT",
            "TLDR",
            "SUMMARIZE_DISCUSSION",
            "CHAT_SUMMARY",
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

        // Parse parameters from message
        let summary_info = service.parse_summary_request(text).await?;

        let mut message_count: u32 = 50; // Default
        if !summary_info.is_null() {
            if let Some(count) = summary_info.get("message_count").and_then(|m| m.as_u64()) {
                message_count = count.clamp(10, 100) as u32;
            }
        }

        // Fetch recent messages
        let messages = service
            .fetch_channel_messages(&context.channel_id, message_count)
            .await?;

        if messages.is_empty() {
            return Ok(ActionResult::failure(
                "I couldn't fetch messages from this channel to summarize.",
            ));
        }

        if messages.len() < 3 {
            return Ok(ActionResult::failure(
                "There aren't enough messages to create a meaningful summary.",
            ));
        }

        // Format messages for summarization
        let conversation_text: Vec<String> = messages
            .iter()
            .filter_map(|msg| {
                let author = msg.get("author").and_then(|a| a.as_str())?;
                let content = msg.get("content").and_then(|c| c.as_str())?;
                if content.is_empty() {
                    None
                } else {
                    Some(format!("{}: {}", author, content))
                }
            })
            .collect();

        // Generate summary using the service's model
        let summary = service
            .generate_summary(
                &conversation_text.join("\n"),
                "Summarize this Discord conversation, highlighting key points, \
                 decisions made, and any action items.",
            )
            .await?;

        if summary.is_empty() {
            return Ok(ActionResult::failure(
                "I couldn't generate a summary. Please try again.",
            ));
        }

        let response_text = format!(
            "📝 **Conversation Summary** ({} messages)\n\n{}",
            messages.len(),
            summary
        );

        Ok(ActionResult::success_with_data(
            response_text,
            serde_json::json!({
                "message_count": messages.len(),
                "summary": summary,
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
        let action = SummarizeConversationAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "summarize the conversation"
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
