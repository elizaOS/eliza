use super::get_feed::{Action, ActionExample};
use async_trait::async_trait;
use serde_json::Value;

pub struct ListFeedsAction;

impl ListFeedsAction {
    fn is_list_request(text: &str) -> bool {
        let lower = text.to_lowercase();
        (lower.contains("list")
            || lower.contains("show")
            || lower.contains("what")
            || lower.contains("subscrib"))
            && (lower.contains("rss") || lower.contains("feed"))
    }
}

#[async_trait]
impl Action for ListFeedsAction {
    fn name(&self) -> &'static str {
        "LIST_RSS_FEEDS"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["SHOW_RSS_FEEDS", "GET_RSS_FEEDS", "RSS_SUBSCRIPTIONS"]
    }

    fn description(&self) -> &'static str {
        "List all subscribed RSS/Atom feeds"
    }

    async fn validate(&self, message_text: &str) -> bool {
        Self::is_list_request(message_text)
    }

    async fn handler(&self, _params: Value) -> Result<Value, String> {
        Ok(serde_json::json!({
            "action": "LIST_RSS_FEEDS",
            "status": "pending_list"
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "What RSS feeds am I subscribed to?".to_string(),
                output: "Let me check your RSS subscriptions".to_string(),
            },
            ActionExample {
                input: "Show me my feeds".to_string(),
                output: "Here are your RSS feeds".to_string(),
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_list() {
        let action = ListFeedsAction;
        assert!(action.validate("list my rss feeds").await);
        assert!(action.validate("show me my feeds").await);
        assert!(action.validate("what feeds am I subscribed to").await);
    }
}
