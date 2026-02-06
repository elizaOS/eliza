mod chat_state;

pub use chat_state::ChatStateProvider;

use async_trait::async_trait;
use serde_json::Value;

#[derive(Debug, Clone)]
/// Context passed to Mattermost providers.
pub struct ProviderContext {
    /// Optional channel ID associated with the current request.
    pub channel_id: Option<String>,
    /// Optional user ID associated with the current request.
    pub user_id: Option<String>,
    /// Optional post ID associated with the current request.
    pub post_id: Option<String>,
    /// Optional root post ID (for threads).
    pub root_id: Option<String>,
    /// Optional team ID associated with the current request.
    pub team_id: Option<String>,
    /// Optional channel type.
    pub channel_type: Option<String>,
    /// Optional room identifier used by the higher-level runtime.
    pub room_id: Option<String>,
}

#[async_trait]
/// Trait implemented by Mattermost providers.
pub trait MattermostProvider: Send + Sync {
    /// Provider name used for registration and lookup.
    fn name(&self) -> &'static str;

    /// Returns provider data as JSON.
    async fn get(&self, context: &ProviderContext) -> Value;
}
