mod chat_state;

pub use chat_state::ChatStateProvider;

use async_trait::async_trait;
use serde_json::Value;

#[derive(Debug, Clone)]
/// Context passed to Telegram providers.
pub struct ProviderContext {
    /// Optional chat ID associated with the current request.
    pub chat_id: Option<i64>,
    /// Optional user ID associated with the current request.
    pub user_id: Option<i64>,
    /// Optional thread/topic ID associated with the current request.
    pub thread_id: Option<i64>,
    /// Optional room identifier used by the higher-level runtime.
    pub room_id: Option<String>,
}

#[async_trait]
/// Trait implemented by Telegram providers.
pub trait TelegramProvider: Send + Sync {
    /// Provider name used for registration and lookup.
    fn name(&self) -> &'static str;

    /// Returns provider data as JSON.
    async fn get(&self, context: &ProviderContext) -> Value;
}
