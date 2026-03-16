use super::get_feed::{Action, ActionExample};
use async_trait::async_trait;
use serde_json::Value;

pub struct UnsubscribeFeedAction;

impl UnsubscribeFeedAction {
    fn is_unsubscribe_request(text: &str) -> bool {
        let lower = text.to_lowercase();
        (lower.contains("unsubscribe")
            || lower.contains("remove")
            || lower.contains("delete")
            || lower.contains("stop"))
            && (lower.contains("rss") || lower.contains("feed"))
    }
}

#[async_trait]
impl Action for UnsubscribeFeedAction {
    fn name(&self) -> &'static str {
        "UNSUBSCRIBE_RSS_FEED"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["REMOVE_RSS_FEED", "DELETE_RSS_FEED", "STOP_RSS_FEED"]
    }

    fn description(&self) -> &'static str {
        "Unsubscribe from an RSS/Atom feed"
    }

    async fn validate(&self, message_text: &str) -> bool {
        Self::is_unsubscribe_request(message_text)
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let url = params
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'url' parameter".to_string())?;

        Ok(serde_json::json!({
            "action": "UNSUBSCRIBE_RSS_FEED",
            "url": url,
            "status": "pending_unsubscription"
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "Unsubscribe from https://example.com/feed.rss".to_string(),
                output: "I'll unsubscribe you from that feed".to_string(),
            },
            ActionExample {
                input: "Remove this feed: https://news.ycombinator.com/rss".to_string(),
                output: "Removing the RSS feed".to_string(),
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_validate_unsubscribe() {
        let action = UnsubscribeFeedAction;
        assert!(action.validate("unsubscribe from rss feed").await);
        assert!(action.validate("remove this feed").await);
        assert!(!action.validate("add this feed").await);
    }
}
