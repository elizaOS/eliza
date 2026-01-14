//! Search messages action

use async_trait::async_trait;

use super::{ActionContext, ActionResult, DiscordAction};
use crate::error::Result;
use crate::DiscordService;

/// Action to search for messages in Discord channels
pub struct SearchMessagesAction;

#[async_trait]
impl DiscordAction for SearchMessagesAction {
    fn name(&self) -> &str {
        "SEARCH_MESSAGES"
    }

    fn description(&self) -> &str {
        "Search for messages in Discord channels by content, author, or other criteria."
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "FIND_MESSAGES",
            "SEARCH_CHAT",
            "LOOK_FOR_MESSAGE",
            "FIND_IN_CHANNEL",
            "SEARCH_HISTORY",
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

        // Parse search criteria from message
        let search_info = service.parse_search_criteria(text).await?;

        let search_query = search_info
            .get("query")
            .and_then(|q| q.as_str())
            .unwrap_or("");

        let author_filter = search_info
            .get("author")
            .and_then(|a| a.as_str())
            .map(String::from);

        let limit = search_info
            .get("limit")
            .and_then(|l| l.as_u64())
            .unwrap_or(25) as u32;

        if search_query.is_empty() && author_filter.is_none() {
            return Ok(ActionResult::failure(
                "I couldn't understand what you want to search for. Please specify search terms.",
            ));
        }

        // Search messages
        let results = service
            .search_messages(
                &context.channel_id,
                search_query,
                author_filter.as_deref(),
                limit,
            )
            .await?;

        if results.is_empty() {
            let mut filter_desc = Vec::new();
            if !search_query.is_empty() {
                filter_desc.push(format!("containing \"{}\"", search_query));
            }
            if let Some(author) = &author_filter {
                filter_desc.push(format!("from {}", author));
            }

            return Ok(ActionResult::success_with_data(
                format!("No messages found {}.", filter_desc.join(" ")),
                serde_json::json!({
                    "results": [],
                    "query": search_query,
                    "author": author_filter,
                }),
            ));
        }

        // Format results (limit display to 10)
        let display_results: Vec<String> = results
            .iter()
            .take(10)
            .map(|msg| {
                let author = msg
                    .get("author")
                    .and_then(|a| a.as_str())
                    .unwrap_or("Unknown");
                let mut content = msg
                    .get("content")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let timestamp = msg.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");

                // Truncate long messages
                if content.len() > 100 {
                    content.truncate(100);
                    content.push_str("...");
                }

                format!("**{}** ({}): {}", author, timestamp, content)
            })
            .collect();

        let mut response_text = format!(
            "Found {} message(s):\n\n{}",
            results.len(),
            display_results.join("\n")
        );

        if results.len() > 10 {
            response_text.push_str(&format!("\n\n*...and {} more*", results.len() - 10));
        }

        Ok(ActionResult::success_with_data(
            response_text,
            serde_json::json!({
                "results": results,
                "query": search_query,
                "author": author_filter,
                "total_count": results.len(),
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
        let action = SearchMessagesAction;
        let context = ActionContext {
            message: json!({
                "source": "discord",
                "content": {
                    "text": "search for messages containing 'meeting'"
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
