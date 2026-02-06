//! Provider interfaces and built-in providers for the Zalo service.

use async_trait::async_trait;
use serde_json::Value;

pub mod chat_state;

pub use chat_state::ChatStateProvider;

/// Context provided to providers.
#[derive(Debug, Clone, Default)]
pub struct ProviderContext {
    /// User ID.
    pub user_id: Option<String>,
    /// Room/chat ID.
    pub room_id: Option<String>,
}

/// Trait for Zalo providers.
#[async_trait]
pub trait ZaloProvider: Send + Sync {
    /// Returns the provider name.
    fn name(&self) -> &'static str;

    /// Gets data from the provider.
    async fn get(&self, context: &ProviderContext) -> Value;
}

/// Returns all built-in providers.
pub fn builtin_providers() -> Vec<Box<dyn ZaloProvider>> {
    vec![Box::new(ChatStateProvider)]
}
