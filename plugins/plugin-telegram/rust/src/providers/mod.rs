//! Telegram providers module
//!
//! Contains provider implementations for Telegram state.

mod chat_state;

pub use chat_state::ChatStateProvider;

use async_trait::async_trait;
use serde_json::Value;

/// Context for provider operations
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// Chat ID
    pub chat_id: Option<i64>,
    /// User ID
    pub user_id: Option<i64>,
    /// Thread ID
    pub thread_id: Option<i64>,
    /// Room ID
    pub room_id: Option<String>,
}

/// Trait for Telegram providers
#[async_trait]
pub trait TelegramProvider: Send + Sync {
    /// Get provider name
    fn name(&self) -> &'static str;

    /// Get current state
    async fn get(&self, context: &ProviderContext) -> Value;
}
