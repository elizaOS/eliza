//! Discord providers for elizaOS
//!
//! Providers supply contextual information for agent decision-making.

mod channel_state;
mod guild_info;
mod voice_state;

pub use channel_state::ChannelStateProvider;
pub use channel_state::ChannelStateProviderCamel;
pub use guild_info::GuildInfoProvider;
pub use guild_info::GuildInfoProviderCamel;
pub use voice_state::VoiceStateProvider;
pub use voice_state::VoiceStateProviderCamel;

use async_trait::async_trait;
use serde_json::Value;

/// Context provided to providers
#[derive(Debug, Clone)]
pub struct ProviderContext {
    /// Current channel ID
    pub channel_id: Option<String>,
    /// Current guild ID
    pub guild_id: Option<String>,
    /// Current user ID
    pub user_id: Option<String>,
    /// Room/conversation ID
    pub room_id: Option<String>,
}

/// Trait for Discord providers
#[async_trait]
pub trait DiscordProvider: Send + Sync {
    /// Provider name
    fn name(&self) -> &str;

    /// Provider description
    fn description(&self) -> &str;

    /// Get the provider's data for the current context
    async fn get(&self, context: &ProviderContext) -> Value;
}

/// Get all available providers
pub fn get_all_providers() -> Vec<Box<dyn DiscordProvider>> {
    vec![
        Box::new(ChannelStateProvider),
        Box::new(VoiceStateProvider),
        Box::new(GuildInfoProvider),
    ]
}
