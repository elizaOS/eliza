//! Provider interfaces and built-in providers for the MS Teams service.

pub mod chat_state;

pub use chat_state::{ChatStateProvider, ConversationMembersProvider, TeamInfoProvider};

use async_trait::async_trait;
use serde_json::Value;

/// Context provided to providers.
pub struct ProviderContext {
    /// Conversation ID.
    pub conversation_id: Option<String>,
    /// User ID.
    pub user_id: Option<String>,
    /// Tenant ID.
    pub tenant_id: Option<String>,
    /// Conversation type.
    pub conversation_type: Option<String>,
    /// Activity ID.
    pub activity_id: Option<String>,
    /// Room ID (elizaOS internal).
    pub room_id: Option<String>,
}

/// Trait for MS Teams providers.
#[async_trait]
pub trait MSTeamsProvider: Send + Sync {
    /// Returns the provider name.
    fn name(&self) -> &'static str;

    /// Returns provider data for the current context.
    async fn get(&self, context: &ProviderContext) -> Value;
}
