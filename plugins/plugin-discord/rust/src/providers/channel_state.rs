//! Channel state provider

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{DiscordProvider, ProviderContext};

/// Provider for Discord channel state information
pub struct ChannelStateProvider;

#[async_trait]
impl DiscordProvider for ChannelStateProvider {
    fn name(&self) -> &str {
        "channel_state"
    }

    fn description(&self) -> &str {
        "Provides information about the current Discord channel, including type, permissions, and activity."
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        let is_dm = context.guild_id.is_none();

        json!({
            "channel_id": context.channel_id,
            "guild_id": context.guild_id,
            "is_dm": is_dm,
            "room_id": context.room_id,
            "channel_type": if is_dm { "dm" } else { "guild_text" },
            // Additional fields would be populated from service when running
            "permissions": {
                "can_send_messages": true,
                "can_add_reactions": true,
                "can_attach_files": true,
                "can_embed_links": true,
            }
        })
    }
}

/// TS-parity alias provider (camelCase name).
pub struct ChannelStateProviderCamel;

#[async_trait]
impl DiscordProvider for ChannelStateProviderCamel {
    fn name(&self) -> &str {
        "channelState"
    }

    fn description(&self) -> &str {
        "Provides information about the current Discord channel, including type, permissions, and activity."
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        ChannelStateProvider.get(context).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_channel_state_dm() {
        let provider = ChannelStateProvider;
        let context = ProviderContext {
            channel_id: Some("123456789012345678".to_string()),
            guild_id: None,
            user_id: Some("987654321098765432".to_string()),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["is_dm"], true);
        assert_eq!(state["channel_type"], "dm");
    }

    #[tokio::test]
    async fn test_channel_state_guild() {
        let provider = ChannelStateProvider;
        let context = ProviderContext {
            channel_id: Some("123456789012345678".to_string()),
            guild_id: Some("111222333444555666".to_string()),
            user_id: Some("987654321098765432".to_string()),
            room_id: Some("room-uuid".to_string()),
        };

        let state = provider.get(&context).await;
        assert_eq!(state["is_dm"], false);
        assert_eq!(state["channel_type"], "guild_text");
    }
}
