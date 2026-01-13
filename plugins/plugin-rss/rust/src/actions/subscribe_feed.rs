use super::get_feed::{Action, ActionExample};
use async_trait::async_trait;
use serde_json::Value;

pub struct SubscribeFeedAction;

impl SubscribeFeedAction {
    fn is_subscribe_request(text: &str) -> bool {
        let lower = text.to_lowercase();
        (lower.contains("subscribe") || lower.contains("add") || lower.contains("follow"))
            && (lower.contains("rss") || lower.contains("feed"))
    }
}

#[async_trait]
impl Action for SubscribeFeedAction {
    fn name(&self) -> &'static str {
        "SUBSCRIBE_RSS_FEED"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["ADD_RSS_FEED", "FOLLOW_RSS_FEED", "SUBSCRIBE_TO_RSS"]
    }

    fn description(&self) -> &'static str {
        "Subscribe to an RSS/Atom feed for automatic monitoring"
    }

    async fn validate(&self, message_text: &str) -> bool {
        Self::is_subscribe_request(message_text)
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let url = params
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'url' parameter".to_string())?;

        Ok(serde_json::json!({
            "action": "SUBSCRIBE_RSS_FEED",
            "url": url,
            "status": "pending_subscription"
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "Subscribe to https://example.com/feed.rss".to_string(),
                output: "I'll subscribe to that RSS feed for you".to_string(),
            },
            ActionExample {
                input: "Add this feed: https://news.ycombinator.com/rss".to_string(),
                output: "Adding the RSS feed".to_string(),
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_subscribe() {
        let action = SubscribeFeedAction;
        assert!(action.validate("subscribe to rss feed").await);
        assert!(action.validate("add this feed").await);
        assert!(!action.validate("show me feeds").await);
    }
}
