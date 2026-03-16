//! Providers for the Tlon plugin.

mod chat_state;

pub use chat_state::ChatStateProvider;

use async_trait::async_trait;
use serde_json::Value;

/// Context for provider queries.
pub struct ProviderContext {
    /// Ship involved in the conversation.
    pub ship: Option<String>,
    /// Channel nest (for group messages).
    pub channel_nest: Option<String>,
    /// Reply to message ID.
    pub reply_to_id: Option<String>,
    /// Room ID.
    pub room_id: Option<String>,
}

/// Trait for Tlon providers.
#[async_trait]
pub trait TlonProvider: Send + Sync {
    /// Returns the provider name.
    fn name(&self) -> &'static str;

    /// Gets the provider state for the given context.
    async fn get(&self, context: &ProviderContext) -> Value;
}
