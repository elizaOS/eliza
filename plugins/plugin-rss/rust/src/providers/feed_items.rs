use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn position(&self) -> i32;
    async fn get(&self, params: ProviderParams) -> ProviderResult;
}

pub struct ProviderParams {
    pub conversation_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub values: HashMap<String, String>,
    pub text: String,
    pub data: Value,
}

/// Feed items provider.
pub struct FeedItemsProvider;

#[async_trait]
impl Provider for FeedItemsProvider {
    fn name(&self) -> &'static str {
        "FEEDITEMS"
    }

    fn description(&self) -> &'static str {
        "Provides recent news and articles from subscribed RSS feeds"
    }

    fn position(&self) -> i32 {
        50
    }

    async fn get(&self, _params: ProviderParams) -> ProviderResult {
        let values = HashMap::from([
            ("itemCount".to_string(), "0".to_string()),
            ("feedCount".to_string(), "0".to_string()),
        ]);

        let text = "No RSS feed items available. Subscribe to feeds to see news articles here."
            .to_string();

        let data = serde_json::json!({
            "count": 0,
            "totalCount": 0,
            "feedCount": 0,
        });

        ProviderResult { values, text, data }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_metadata() {
        let provider = FeedItemsProvider;
        assert_eq!(provider.name(), "FEEDITEMS");
        assert_eq!(provider.position(), 50);
    }

    #[tokio::test]
    async fn test_get_empty() {
        let provider = FeedItemsProvider;
        let params = ProviderParams {
            conversation_id: "test".to_string(),
            agent_id: "test".to_string(),
        };

        let result = provider.get(params).await;
        assert!(result.text.contains("No RSS feed items"));
    }
}
