use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait Action: Send + Sync {
    fn name(&self) -> &'static str;
    fn similes(&self) -> Vec<&'static str>;
    fn description(&self) -> &'static str;
    async fn validate(&self, message_text: &str) -> bool;
    async fn handler(&self, params: Value) -> Result<Value, String>;
    fn examples(&self) -> Vec<ActionExample>;
}

pub struct ActionExample {
    pub input: String,
    pub output: String,
}

pub struct GetFeedAction;

#[async_trait]
impl Action for GetFeedAction {
    fn name(&self) -> &'static str {
        "GET_NEWSFEED"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["FETCH_RSS", "READ_FEED", "DOWNLOAD_FEED"]
    }

    fn description(&self) -> &'static str {
        "Download and parse an RSS/Atom feed from a URL"
    }

    async fn validate(&self, _message_text: &str) -> bool {
        true
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let url = params
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'url' parameter".to_string())?;

        Ok(serde_json::json!({
            "action": "GET_NEWSFEED",
            "url": url,
            "status": "pending_fetch"
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "Read https://server.com/feed.rss".to_string(),
                output: "I'll check that out".to_string(),
            },
            ActionExample {
                input: "Fetch the news from https://news.ycombinator.com/rss".to_string(),
                output: "Fetching the Hacker News feed now".to_string(),
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_metadata() {
        let action = GetFeedAction;
        assert_eq!(action.name(), "GET_NEWSFEED");
        assert!(action.similes().contains(&"FETCH_RSS"));
    }

    #[tokio::test]
    async fn test_validate() {
        let action = GetFeedAction;
        assert!(action.validate("fetch rss").await);
    }
}
