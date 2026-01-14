//! Polymarket provider implementation
//!
//! Provides current Polymarket market information and context.

use async_trait::async_trait;
use chrono::Utc;

use super::{PolymarketProviderTrait, ProviderContext, ProviderResult};
use crate::constants::{DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID};

/// Polymarket context provider
pub struct PolymarketProvider;

#[async_trait]
impl PolymarketProviderTrait for PolymarketProvider {
    fn name(&self) -> &'static str {
        "POLYMARKET_PROVIDER"
    }

    fn description(&self) -> &'static str {
        "Provides current Polymarket market information and context"
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let clob_api_url = context
            .clob_api_url
            .as_deref()
            .unwrap_or(DEFAULT_CLOB_API_URL);

        let mut features_available = vec!["market_data", "price_feeds", "order_book"];
        if context.has_private_key {
            features_available.push("wallet_operations");
        }
        if context.has_api_creds {
            features_available.push("authenticated_requests");
        }

        let features_str = features_available.join(", ");

        ProviderResult {
            text: format!(
                "Connected to Polymarket CLOB at {} on Polygon (Chain ID: {}). Features available: {}.",
                clob_api_url, POLYGON_CHAIN_ID, features_str
            ),
            values: serde_json::json!({
                "clobApiUrl": clob_api_url,
                "chainId": POLYGON_CHAIN_ID,
                "serviceStatus": "active",
                "hasPrivateKey": context.has_private_key,
                "hasApiCreds": context.has_api_creds,
                "featuresAvailable": features_available,
            }),
            data: serde_json::json!({
                "timestamp": Utc::now().to_rfc3339(),
                "service": "polymarket",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_polymarket_provider_basic() {
        let provider = PolymarketProvider;
        let context = ProviderContext::default();

        let result = provider.get(&context).await;

        assert!(result.text.contains("Polymarket CLOB"));
        assert!(result.text.contains("market_data"));
    }

    #[tokio::test]
    async fn test_polymarket_provider_with_auth() {
        let provider = PolymarketProvider;
        let context = ProviderContext {
            clob_api_url: Some("https://custom.api".to_string()),
            has_private_key: true,
            has_api_creds: true,
        };

        let result = provider.get(&context).await;

        assert!(result.text.contains("wallet_operations"));
        assert!(result.text.contains("authenticated_requests"));
        assert!(result.text.contains("custom.api"));
    }

    #[test]
    fn test_provider_metadata() {
        let provider = PolymarketProvider;
        assert_eq!(provider.name(), "POLYMARKET_PROVIDER");
        assert!(provider.description().contains("Polymarket"));
    }
}
