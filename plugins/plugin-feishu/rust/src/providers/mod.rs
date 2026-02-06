//! Provider interfaces and built-in providers for the Feishu plugin.

use serde_json::Value;

mod chat_state;

pub use chat_state::ChatStateProvider;

/// Context provided to providers.
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// The incoming message data.
    pub message: Value,
    /// The chat ID.
    pub chat_id: Option<String>,
    /// The message ID.
    pub message_id: Option<String>,
    /// Current state.
    pub state: Value,
}

/// Trait for implementing Feishu providers.
pub trait FeishuProvider: Send + Sync {
    /// Returns the provider name.
    fn name(&self) -> &'static str;

    /// Returns a human-readable description of the provider.
    fn description(&self) -> &'static str;

    /// Gets provider data for the given context.
    fn get(&self, context: &ProviderContext) -> Option<String>;
}
