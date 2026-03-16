//! Guild info provider

use async_trait::async_trait;
use serde_json::{json, Value};

use super::{DiscordProvider, ProviderContext};

/// Provider for Discord guild/server information
pub struct GuildInfoProvider;

#[async_trait]
impl DiscordProvider for GuildInfoProvider {
    fn name(&self) -> &str {
        "guild_info"
    }

    fn description(&self) -> &str {
        "Provides information about the current Discord guild/server, including name, members, and channels."
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        match &context.guild_id {
            Some(guild_id) => {
                // This would be populated from the Discord service when running
                json!({
                    "guild_id": guild_id,
                    "is_in_guild": true,
                    "guild": {
                        "name": null, // Populated at runtime
                        "member_count": null,
                        "owner_id": null,
                        "description": null,
                    },
                    "channels": {
                        "text": [],
                        "voice": [],
                        "categories": [],
                    },
                    "roles": [],
                    "bot_permissions": {
                        "administrator": false,
                        "manage_messages": false,
                        "manage_channels": false,
                        "manage_roles": false,
                    }
                })
            }
            None => {
                json!({
                    "guild_id": null,
                    "is_in_guild": false,
                    "guild": null,
                })
            }
        }
    }
}

/// TS-parity alias provider (camelCase name).
pub struct GuildInfoProviderCamel;

#[async_trait]
impl DiscordProvider for GuildInfoProviderCamel {
    fn name(&self) -> &str {
        "guildInfo"
    }

    fn description(&self) -> &str {
        "Provides information about the current Discord guild/server, including name, members, and channels."
    }

    async fn get(&self, context: &ProviderContext) -> Value {
        GuildInfoProvider.get(context).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_guild_info_with_guild() {
        let provider = GuildInfoProvider;
        let context = ProviderContext {
            channel_id: Some("123456789012345678".to_string()),
            guild_id: Some("111222333444555666".to_string()),
            user_id: Some("987654321098765432".to_string()),
            room_id: None,
        };

        let state = provider.get(&context).await;
        assert_eq!(state["is_in_guild"], true);
        assert_eq!(state["guild_id"], "111222333444555666");
    }

    #[tokio::test]
    async fn test_guild_info_without_guild() {
        let provider = GuildInfoProvider;
        let context = ProviderContext {
            channel_id: Some("123456789012345678".to_string()),
            guild_id: None,
            user_id: Some("987654321098765432".to_string()),
            room_id: None,
        };

        let state = provider.get(&context).await;
        assert_eq!(state["is_in_guild"], false);
        assert!(state["guild"].is_null());
    }
}
