//! Polymarket providers
//!
//! Provides context data for Polymarket interactions.

mod polymarket;

pub use polymarket::PolymarketProvider;

use async_trait::async_trait;
use serde_json::Value;

/// Provider context containing runtime settings.
#[derive(Debug, Clone, Default)]
pub struct ProviderContext {
    /// CLOB API URL
    pub clob_api_url: Option<String>,
    /// Whether a private key is configured
    pub has_private_key: bool,
    /// Whether API credentials are configured
    pub has_api_creds: bool,
}

/// Result from a provider call.
#[derive(Debug, Clone)]
pub struct ProviderResult {
    /// Human-readable text
    pub text: String,
    /// Key-value pairs for template substitution
    pub values: Value,
    /// Structured data
    pub data: Value,
}

impl Default for ProviderResult {
    fn default() -> Self {
        Self {
            text: String::new(),
            values: serde_json::json!({}),
            data: serde_json::json!({}),
        }
    }
}

/// Trait for Polymarket providers.
#[async_trait]
pub trait PolymarketProviderTrait: Send + Sync {
    /// Returns the provider name.
    fn name(&self) -> &'static str;

    /// Returns the provider description.
    fn description(&self) -> &'static str;

    /// Gets the provider data.
    async fn get(&self, context: &ProviderContext) -> ProviderResult;
}

/// Returns all available providers.
pub fn get_providers() -> Vec<Box<dyn PolymarketProviderTrait>> {
    vec![Box::new(PolymarketProvider)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_providers() {
        let providers = get_providers();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name(), "POLYMARKET_PROVIDER");
    }
}
