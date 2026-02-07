//! ACP Providers for elizaOS
//!
//! Providers supply contextual information about ACP checkout sessions.

use crate::error::Result;
use crate::types::CheckoutSession;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Provider context for data access
#[derive(Debug, Clone, Default)]
pub struct ProviderContext {
    /// Environment variables
    pub env: HashMap<String, String>,
    /// User ID
    pub user_id: Option<String>,
    /// Conversation ID
    pub conversation_id: Option<String>,
}

impl ProviderContext {
    /// Create a new provider context
    pub fn new() -> Self {
        Self::default()
    }

    /// Get an environment variable
    pub fn get_env(&self, key: &str) -> Option<&String> {
        self.env.get(key)
    }
}

/// Trait for ACP providers
#[async_trait]
pub trait AcpProvider {
    /// Provider name
    fn name(&self) -> &'static str;

    /// Provider description
    fn description(&self) -> &'static str;

    /// Get contextual data as a formatted string
    async fn get(&self, context: &ProviderContext) -> Result<String>;
}

/// Checkout session cache for storing active sessions
#[derive(Debug, Default)]
pub struct CheckoutSessionCache {
    sessions: Arc<RwLock<HashMap<String, CheckoutSession>>>,
}

impl CheckoutSessionCache {
    /// Create a new cache
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Store a session
    pub async fn set(&self, session: CheckoutSession) {
        let mut sessions = self.sessions.write().await;
        sessions.insert(session.id.clone(), session);
    }

    /// Get a session by ID
    pub async fn get(&self, session_id: &str) -> Option<CheckoutSession> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).cloned()
    }

    /// Remove a session
    pub async fn remove(&self, session_id: &str) -> Option<CheckoutSession> {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id)
    }

    /// Get all sessions
    pub async fn all(&self) -> Vec<CheckoutSession> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    /// Get session count
    pub async fn len(&self) -> usize {
        let sessions = self.sessions.read().await;
        sessions.len()
    }

    /// Check if cache is empty
    pub async fn is_empty(&self) -> bool {
        let sessions = self.sessions.read().await;
        sessions.is_empty()
    }

    /// Clear all sessions
    pub async fn clear(&self) {
        let mut sessions = self.sessions.write().await;
        sessions.clear();
    }
}

impl Clone for CheckoutSessionCache {
    fn clone(&self) -> Self {
        Self {
            sessions: Arc::clone(&self.sessions),
        }
    }
}

/// Provider for active checkout sessions
pub struct CheckoutSessionsProvider {
    cache: CheckoutSessionCache,
}

impl CheckoutSessionsProvider {
    /// Create a new provider with a cache
    pub fn new(cache: CheckoutSessionCache) -> Self {
        Self { cache }
    }
}

#[async_trait]
impl AcpProvider for CheckoutSessionsProvider {
    fn name(&self) -> &'static str {
        "checkoutSessions"
    }

    fn description(&self) -> &'static str {
        "Provides information about active ACP checkout sessions"
    }

    async fn get(&self, _context: &ProviderContext) -> Result<String> {
        let sessions = self.cache.all().await;

        if sessions.is_empty() {
            return Ok("No active checkout sessions.".to_string());
        }

        let mut output = String::from("Active checkout sessions:\n");

        for session in sessions {
            output.push_str(&format!("\n## Session: {}\n", session.id));
            output.push_str(&format!("Status: {:?}\n", session.status));
            output.push_str(&format!("Currency: {}\n", session.currency));
            output.push_str(&format!("Items: {}\n", session.line_items.len()));

            // Calculate total from totals array
            if let Some(total) = session
                .totals
                .iter()
                .find(|t| matches!(t.total_type, crate::types::TotalType::Total))
            {
                output.push_str(&format!(
                    "Total: {} {}\n",
                    format_amount(total.amount, &session.currency),
                    session.currency
                ));
            }

            if let Some(ref buyer) = session.buyer {
                output.push_str(&format!("Buyer: {}\n", buyer.email));
            }
        }

        Ok(output)
    }
}

/// Provider for ACP configuration status
pub struct AcpConfigProvider;

impl AcpConfigProvider {
    /// Create a new provider
    pub fn new() -> Self {
        Self
    }
}

impl Default for AcpConfigProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AcpProvider for AcpConfigProvider {
    fn name(&self) -> &'static str {
        "acpConfig"
    }

    fn description(&self) -> &'static str {
        "Provides ACP configuration status"
    }

    async fn get(&self, context: &ProviderContext) -> Result<String> {
        let mut output = String::from("ACP Configuration:\n");

        let base_url = context.get_env("ACP_MERCHANT_BASE_URL");
        let api_key = context.get_env("ACP_MERCHANT_API_KEY");

        output.push_str(&format!(
            "- Merchant URL: {}\n",
            if base_url.is_some() {
                "configured"
            } else {
                "not set"
            }
        ));
        output.push_str(&format!(
            "- API Key: {}\n",
            if api_key.is_some() {
                "configured"
            } else {
                "not set"
            }
        ));

        if base_url.is_none() {
            output.push_str("\nNote: Set ACP_MERCHANT_BASE_URL to enable checkout operations.\n");
        }

        Ok(output)
    }
}

/// Format an amount in minor units to display format
fn format_amount(amount: i64, currency: &str) -> String {
    let currency_upper = currency.to_uppercase();
    
    let symbol = match currency_upper.as_str() {
        "USD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" => "¥",
        _ => "",
    };
    
    // Zero-decimal currencies (JPY, KRW, etc.) don't have minor units
    if currency_upper == "JPY" || currency_upper == "KRW" {
        format!("{}{}", symbol, amount)
    } else {
        let major = amount / 100;
        let minor = (amount % 100).abs();
        format!("{}{}.{:02}", symbol, major, minor)
    }
}

/// Checkout session summary for serialization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutSessionSummary {
    /// Session ID
    pub id: String,
    /// Status
    pub status: String,
    /// Currency
    pub currency: String,
    /// Number of items
    pub item_count: usize,
    /// Total amount
    pub total_amount: Option<i64>,
    /// Buyer email
    pub buyer_email: Option<String>,
}

impl From<&CheckoutSession> for CheckoutSessionSummary {
    fn from(session: &CheckoutSession) -> Self {
        Self {
            id: session.id.clone(),
            status: format!("{:?}", session.status),
            currency: session.currency.clone(),
            item_count: session.line_items.len(),
            total_amount: session
                .totals
                .iter()
                .find(|t| matches!(t.total_type, crate::types::TotalType::Total))
                .map(|t| t.amount),
            buyer_email: session.buyer.as_ref().map(|b| b.email.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CheckoutSessionStatus, LineItem, Item, Total, TotalType};

    fn create_test_session(id: &str) -> CheckoutSession {
        CheckoutSession {
            id: id.to_string(),
            protocol: None,
            capabilities: None,
            buyer: None,
            status: CheckoutSessionStatus::Incomplete,
            currency: "USD".to_string(),
            line_items: vec![LineItem {
                id: "li_1".to_string(),
                item: Item {
                    id: "item_1".to_string(),
                    name: Some("Test Item".to_string()),
                    unit_amount: Some(1000),
                    quantity: Some(1),
                },
                quantity: 1,
                name: Some("Test Item".to_string()),
                description: None,
                images: None,
                unit_amount: Some(1000),
                product_id: None,
                sku: None,
                availability_status: None,
                totals: None,
            }],
            fulfillment_details: None,
            fulfillment_options: vec![],
            selected_fulfillment_options: None,
            totals: vec![Total {
                total_type: TotalType::Total,
                display_text: "Total".to_string(),
                amount: 1000,
                presentment_amount: None,
                description: None,
                breakdown: None,
            }],
            messages: vec![],
            links: vec![],
            created_at: None,
            updated_at: None,
            expires_at: None,
            continue_url: None,
            metadata: None,
            discounts: None,
            order: None,
        }
    }

    #[tokio::test]
    async fn test_checkout_session_cache() {
        let cache = CheckoutSessionCache::new();
        assert!(cache.is_empty().await);

        let session = create_test_session("cs_123");
        cache.set(session.clone()).await;

        assert_eq!(cache.len().await, 1);
        assert!(!cache.is_empty().await);

        let retrieved = cache.get("cs_123").await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().id, "cs_123");

        let removed = cache.remove("cs_123").await;
        assert!(removed.is_some());
        assert!(cache.is_empty().await);
    }

    #[tokio::test]
    async fn test_checkout_sessions_provider_empty() {
        let cache = CheckoutSessionCache::new();
        let provider = CheckoutSessionsProvider::new(cache);
        let context = ProviderContext::new();

        let result = provider.get(&context).await.unwrap();
        assert_eq!(result, "No active checkout sessions.");
    }

    #[tokio::test]
    async fn test_checkout_sessions_provider_with_sessions() {
        let cache = CheckoutSessionCache::new();
        cache.set(create_test_session("cs_123")).await;

        let provider = CheckoutSessionsProvider::new(cache);
        let context = ProviderContext::new();

        let result = provider.get(&context).await.unwrap();
        assert!(result.contains("cs_123"));
        assert!(result.contains("Incomplete"));
        assert!(result.contains("USD"));
    }

    #[tokio::test]
    async fn test_acp_config_provider() {
        let provider = AcpConfigProvider::new();
        let mut context = ProviderContext::new();

        // Without config
        let result = provider.get(&context).await.unwrap();
        assert!(result.contains("not set"));

        // With config
        context
            .env
            .insert("ACP_MERCHANT_BASE_URL".to_string(), "https://api.test.com".to_string());
        let result = provider.get(&context).await.unwrap();
        assert!(result.contains("configured"));
    }

    #[test]
    fn test_format_amount() {
        assert_eq!(format_amount(1000, "USD"), "$10.00");
        assert_eq!(format_amount(1234, "EUR"), "€12.34");
        assert_eq!(format_amount(500, "GBP"), "£5.00");
        assert_eq!(format_amount(1000, "JPY"), "¥1000");
        assert_eq!(format_amount(1050, "CAD"), "10.50");
    }

    #[test]
    fn test_checkout_session_summary() {
        let session = create_test_session("cs_123");
        let summary = CheckoutSessionSummary::from(&session);

        assert_eq!(summary.id, "cs_123");
        assert_eq!(summary.status, "Incomplete");
        assert_eq!(summary.currency, "USD");
        assert_eq!(summary.item_count, 1);
        assert_eq!(summary.total_amount, Some(1000));
    }
}
