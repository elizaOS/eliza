//! Voice state provider

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{DiscordProvider, ProviderContext};

/// Provider for Discord voice state information
pub struct VoiceStateProvider;

#[async_trait]
impl DiscordProvider for VoiceStateProvider {
    fn name(&self) -> &str {
        "voice_state"
    }

    fn description(&self) -> &str {
        "Provides information about voice channel state, including connected users and speaking status."
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        // This would be populated from the Discord service when running
        // For now, return a template structure
        json!({
            "guild_id": context.guild_id,
            "user_id": context.user_id,
            "voice_channel": {
                "connected": false,
                "channel_id": null,
                "channel_name": null,
            },
            "self_state": {
                "muted": false,
                "deafened": false,
                "streaming": false,
                "video": false,
            },
            "members_in_voice": [],
            "speaking_members": [],
        })
    }
}

/// TS-parity alias provider (camelCase name).
pub struct VoiceStateProviderCamel;

#[async_trait]
impl DiscordProvider for VoiceStateProviderCamel {
    fn name(&self) -> &str {
        "voiceState"
    }

    fn description(&self) -> &str {
        "Provides information about voice channel state, including connected users and speaking status."
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        VoiceStateProvider.get(context).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_voice_state() {
        let provider = VoiceStateProvider;
        let context = ProviderContext {
            channel_id: Some("123456789012345678".to_string()),
            guild_id: Some("111222333444555666".to_string()),
            user_id: Some("987654321098765432".to_string()),
            room_id: None,
        };

        let state = provider.get(&context).await;
        assert_eq!(state["voice_channel"]["connected"], false);
        assert!(state["members_in_voice"].as_array().unwrap().is_empty());
    }
}
