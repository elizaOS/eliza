//! Instagram providers module
//!
//! Contains provider implementations for Instagram state.

mod user_state;

pub use user_state::UserStateProvider;

use async_trait::async_trait;
use serde_json::Value;

/// Context for provider operations
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// User ID
    pub user_id: Option<i64>,
    /// Thread ID
    pub thread_id: Option<String>,
    /// Media ID
    pub media_id: Option<i64>,
    /// Room/conversation ID
    pub room_id: Option<String>,
}

/// Trait for Instagram providers
#[async_trait]
pub trait InstagramProvider: Send + Sync {
    /// Get provider name
    fn name(&self) -> &'static str;

    /// Get current state
    async fn get(&self, context: &ProviderContext) -> Value;
}
