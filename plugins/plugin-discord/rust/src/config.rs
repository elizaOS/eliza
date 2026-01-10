//! Discord plugin configuration
//!
//! Configuration can be loaded from environment variables or constructed programmatically.

use serde::{Deserialize, Serialize};

use crate::error::{DiscordError, Result};

/// Discord plugin configuration
///
/// Contains all settings required to connect to and operate a Discord bot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordConfig {
    /// Bot token for Discord API authentication (required)
    pub token: String,

    /// Discord application ID (required)
    pub application_id: String,

    /// List of channel IDs where the bot should operate
    pub channel_ids: Vec<String>,

    /// Channel ID used for testing
    pub test_channel_id: Option<String>,

    /// Voice channel ID for automatic joining
    pub voice_channel_id: Option<String>,

    /// Whether to ignore messages from other bots
    pub should_ignore_bot_messages: bool,

    /// Whether to ignore direct messages
    pub should_ignore_direct_messages: bool,

    /// Whether to only respond when mentioned
    pub should_respond_only_to_mentions: bool,

    /// Channel IDs where bot only listens (doesn't respond)
    pub listen_only_channel_ids: Vec<String>,
}

impl DiscordConfig {
    /// Create a new configuration with required fields only
    ///
    /// # Arguments
    ///
    /// * `token` - Discord bot token
    /// * `application_id` - Discord application ID
    ///
    /// # Example
    ///
    /// ```
    /// use elizaos_plugin_discord::DiscordConfig;
    ///
    /// let config = DiscordConfig::new(
    ///     "your-bot-token".to_string(),
    ///     "your-application-id".to_string(),
    /// );
    /// ```
    pub fn new(token: String, application_id: String) -> Self {
        Self {
            token,
            application_id,
            channel_ids: Vec::new(),
            test_channel_id: None,
            voice_channel_id: None,
            should_ignore_bot_messages: true,
            should_ignore_direct_messages: false,
            should_respond_only_to_mentions: false,
            listen_only_channel_ids: Vec::new(),
        }
    }

    /// Load configuration from environment variables
    ///
    /// # Required Variables
    ///
    /// - `DISCORD_API_TOKEN`: Bot token
    /// - `DISCORD_APPLICATION_ID`: Application ID
    ///
    /// # Optional Variables
    ///
    /// - `CHANNEL_IDS`: Comma-separated list of channel IDs
    /// - `DISCORD_TEST_CHANNEL_ID`: Test channel ID
    /// - `DISCORD_VOICE_CHANNEL_ID`: Voice channel ID
    /// - `DISCORD_SHOULD_IGNORE_BOT_MESSAGES`: "true" or "false"
    /// - `DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES`: "true" or "false"
    /// - `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS`: "true" or "false"
    /// - `DISCORD_LISTEN_CHANNEL_IDS`: Comma-separated list of listen-only channel IDs
    ///
    /// # Errors
    ///
    /// Returns `DiscordError::MissingSetting` if required variables are missing.
    pub fn from_env() -> Result<Self> {
        let token = std::env::var("DISCORD_API_TOKEN")
            .map_err(|_| DiscordError::MissingSetting("DISCORD_API_TOKEN".to_string()))?;

        let application_id = std::env::var("DISCORD_APPLICATION_ID")
            .map_err(|_| DiscordError::MissingSetting("DISCORD_APPLICATION_ID".to_string()))?;

        // Validate token is not empty
        if token.is_empty() {
            return Err(DiscordError::ConfigError(
                "DISCORD_API_TOKEN cannot be empty".to_string(),
            ));
        }

        // Validate application_id is not empty
        if application_id.is_empty() {
            return Err(DiscordError::ConfigError(
                "DISCORD_APPLICATION_ID cannot be empty".to_string(),
            ));
        }

        let channel_ids = std::env::var("CHANNEL_IDS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let test_channel_id = std::env::var("DISCORD_TEST_CHANNEL_ID").ok();
        let voice_channel_id = std::env::var("DISCORD_VOICE_CHANNEL_ID").ok();

        let should_ignore_bot_messages = std::env::var("DISCORD_SHOULD_IGNORE_BOT_MESSAGES")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        let should_ignore_direct_messages = std::env::var("DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);

        let should_respond_only_to_mentions =
            std::env::var("DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS")
                .ok()
                .map(|s| s.to_lowercase() == "true")
                .unwrap_or(false);

        let listen_only_channel_ids = std::env::var("DISCORD_LISTEN_CHANNEL_IDS")
            .ok()
            .map(|s| {
                s.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        Ok(Self {
            token,
            application_id,
            channel_ids,
            test_channel_id,
            voice_channel_id,
            should_ignore_bot_messages,
            should_ignore_direct_messages,
            should_respond_only_to_mentions,
            listen_only_channel_ids,
        })
    }

    /// Set channel IDs (builder pattern)
    pub fn with_channel_ids(mut self, ids: Vec<String>) -> Self {
        self.channel_ids = ids;
        self
    }

    /// Set test channel ID (builder pattern)
    pub fn with_test_channel_id(mut self, id: String) -> Self {
        self.test_channel_id = Some(id);
        self
    }

    /// Set voice channel ID (builder pattern)
    pub fn with_voice_channel_id(mut self, id: String) -> Self {
        self.voice_channel_id = Some(id);
        self
    }

    /// Set whether to ignore bot messages (builder pattern)
    pub fn with_ignore_bot_messages(mut self, ignore: bool) -> Self {
        self.should_ignore_bot_messages = ignore;
        self
    }

    /// Set whether to ignore direct messages (builder pattern)
    pub fn with_ignore_direct_messages(mut self, ignore: bool) -> Self {
        self.should_ignore_direct_messages = ignore;
        self
    }

    /// Set whether to only respond to mentions (builder pattern)
    pub fn with_respond_only_to_mentions(mut self, only_mentions: bool) -> Self {
        self.should_respond_only_to_mentions = only_mentions;
        self
    }

    /// Validate configuration
    pub fn validate(&self) -> Result<()> {
        if self.token.is_empty() {
            return Err(DiscordError::ConfigError(
                "Token cannot be empty".to_string(),
            ));
        }

        if self.application_id.is_empty() {
            return Err(DiscordError::ConfigError(
                "Application ID cannot be empty".to_string(),
            ));
        }

        // Validate channel IDs are valid snowflakes
        for id in &self.channel_ids {
            validate_snowflake(id)?;
        }

        if let Some(ref id) = self.test_channel_id {
            validate_snowflake(id)?;
        }

        if let Some(ref id) = self.voice_channel_id {
            validate_snowflake(id)?;
        }

        for id in &self.listen_only_channel_ids {
            validate_snowflake(id)?;
        }

        Ok(())
    }
}

/// Validate a Discord snowflake ID
fn validate_snowflake(id: &str) -> Result<()> {
    if id.len() < 17 || id.len() > 19 {
        return Err(DiscordError::InvalidSnowflake(format!(
            "Snowflake must be 17-19 characters, got {}",
            id.len()
        )));
    }

    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(DiscordError::InvalidSnowflake(
            "Snowflake must contain only digits".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = DiscordConfig::new("token".to_string(), "app_id".to_string());
        assert_eq!(config.token, "token");
        assert_eq!(config.application_id, "app_id");
        assert!(config.should_ignore_bot_messages);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = DiscordConfig::new("token".to_string(), "app_id".to_string())
            .with_channel_ids(vec!["12345678901234567".to_string()])
            .with_ignore_bot_messages(false)
            .with_respond_only_to_mentions(true);

        assert!(!config.should_ignore_bot_messages);
        assert!(config.should_respond_only_to_mentions);
        assert_eq!(config.channel_ids.len(), 1);
    }

    #[test]
    fn test_validate_snowflake_valid() {
        assert!(validate_snowflake("12345678901234567").is_ok());
        assert!(validate_snowflake("123456789012345678").is_ok());
        assert!(validate_snowflake("1234567890123456789").is_ok());
    }

    #[test]
    fn test_validate_snowflake_invalid() {
        assert!(validate_snowflake("1234567890123456").is_err()); // Too short
        assert!(validate_snowflake("12345678901234567890").is_err()); // Too long
        assert!(validate_snowflake("1234567890123456a").is_err()); // Contains letter
        assert!(validate_snowflake("").is_err()); // Empty
    }
}
