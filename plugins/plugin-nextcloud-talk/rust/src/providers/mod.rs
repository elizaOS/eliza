mod chat_state;

pub use chat_state::ChatStateProvider;

use async_trait::async_trait;
use serde_json::Value;

#[derive(Debug, Clone)]
/// Context passed to Nextcloud Talk providers.
pub struct ProviderContext {
    /// Optional room token associated with the current request.
    pub room_token: Option<String>,
    /// Optional user ID associated with the current request.
    pub user_id: Option<String>,
    /// Optional room name associated with the current request.
    pub room_name: Option<String>,
    /// Optional room identifier used by the higher-level runtime.
    pub room_id: Option<String>,
    /// Whether this is a group chat.
    pub is_group_chat: Option<bool>,
}

#[async_trait]
/// Trait implemented by Nextcloud Talk providers.
pub trait NextcloudTalkProvider: Send + Sync {
    /// Provider name used for registration and lookup.
    fn name(&self) -> &'static str;

    /// Returns provider data as JSON.
    async fn get(&self, context: &ProviderContext) -> Value;
}
