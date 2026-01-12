//! Telegram plugin configuration
//!
//! Configuration can be loaded from environment variables or constructed programmatically.

use serde::{Deserialize, Serialize};

use crate::error::{Result, TelegramError};

/// Telegram plugin configuration
///
/// Contains all settings required to connect to and operate a Telegram bot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    /// Bot token for Telegram API authentication (required)
    pub bot_token: String,

    /// Optional custom API root URL
    pub api_root: Option<String>,

    /// List of allowed chat IDs (empty = all chats allowed)
    pub allowed_chat_ids: Vec<i64>,

    /// Chat ID used for testing
    pub test_chat_id: Option<i64>,

    /// Whether to ignore messages from other bots
    pub should_ignore_bot_messages: bool,

    /// Whether to only respond in groups when mentioned
    pub should_respond_only_to_mentions: bool,

    /// Bot username (without @)
    pub bot_username: Option<String>,
}

impl TelegramConfig {
    /// Create a new configuration with required fields only
    ///
    /// # Arguments
    ///
    /// * `bot_token` - Telegram bot token from BotFather
    ///
    /// # Example
    ///
    /// ```
    /// use elizaos_plugin_telegram::TelegramConfig;
    ///
    /// let config = TelegramConfig::new("your-bot-token".to_string());
    /// ```
    pub fn new(bot_token: String) -> Self {
        Self {
            bot_token,
            api_root: None,
            allowed_chat_ids: Vec::new(),
            test_chat_id: None,
            should_ignore_bot_messages: true,
            should_respond_only_to_mentions: false,
            bot_username: None,
        }
    }

    /// Load configuration from environment variables
    ///
    /// # Required Variables
    ///
    /// - `TELEGRAM_BOT_TOKEN`: Bot token from BotFather
    ///
    /// # Optional Variables
    ///
    /// - `TELEGRAM_API_ROOT`: Custom API root URL
    /// - `TELEGRAM_ALLOWED_CHATS`: JSON array of allowed chat IDs
    /// - `TELEGRAM_TEST_CHAT_ID`: Chat ID for testing
    /// - `TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES`: "true" or "false"
    /// - `TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS`: "true" or "false"
    /// - `TELEGRAM_BOT_USERNAME`: Bot username
    ///
    /// # Errors
    ///
    /// Returns `TelegramError::MissingSetting` if required variables are missing.
    pub fn from_env() -> Result<Self> {
        let bot_token = std::env::var("TELEGRAM_BOT_TOKEN")
            .map_err(|_| TelegramError::MissingSetting("TELEGRAM_BOT_TOKEN".to_string()))?;

        // Validate token is not empty
        if bot_token.is_empty() {
            return Err(TelegramError::ConfigError(
                "TELEGRAM_BOT_TOKEN cannot be empty".to_string(),
            ));
        }

        let api_root = std::env::var("TELEGRAM_API_ROOT").ok();

        let allowed_chat_ids = std::env::var("TELEGRAM_ALLOWED_CHATS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let test_chat_id = std::env::var("TELEGRAM_TEST_CHAT_ID")
            .ok()
            .and_then(|s| s.parse().ok());

        let should_ignore_bot_messages = std::env::var("TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        let should_respond_only_to_mentions =
            std::env::var("TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS")
                .ok()
                .map(|s| s.to_lowercase() == "true")
                .unwrap_or(false);

        let bot_username = std::env::var("TELEGRAM_BOT_USERNAME").ok();

        Ok(Self {
            bot_token,
            api_root,
            allowed_chat_ids,
            test_chat_id,
            should_ignore_bot_messages,
            should_respond_only_to_mentions,
            bot_username,
        })
    }

    /// Set API root URL (builder pattern)
    pub fn with_api_root(mut self, url: String) -> Self {
        self.api_root = Some(url);
        self
    }

    /// Set allowed chat IDs (builder pattern)
    pub fn with_allowed_chat_ids(mut self, ids: Vec<i64>) -> Self {
        self.allowed_chat_ids = ids;
        self
    }

    /// Set test chat ID (builder pattern)
    pub fn with_test_chat_id(mut self, id: i64) -> Self {
        self.test_chat_id = Some(id);
        self
    }

    /// Set whether to ignore bot messages (builder pattern)
    pub fn with_ignore_bot_messages(mut self, ignore: bool) -> Self {
        self.should_ignore_bot_messages = ignore;
        self
    }

    /// Set whether to only respond to mentions (builder pattern)
    pub fn with_respond_only_to_mentions(mut self, only_mentions: bool) -> Self {
        self.should_respond_only_to_mentions = only_mentions;
        self
    }

    /// Set bot username (builder pattern)
    pub fn with_bot_username(mut self, username: String) -> Self {
        self.bot_username = Some(username);
        self
    }

    /// Validate configuration
    pub fn validate(&self) -> Result<()> {
        if self.bot_token.is_empty() {
            return Err(TelegramError::ConfigError(
                "Bot token cannot be empty".to_string(),
            ));
        }

        // Validate bot token format (should contain a colon)
        if !self.bot_token.contains(':') {
            return Err(TelegramError::ConfigError(
                "Bot token format is invalid (should contain ':')".to_string(),
            ));
        }

        Ok(())
    }

    /// Check if a chat is allowed
    pub fn is_chat_allowed(&self, chat_id: i64) -> bool {
        self.allowed_chat_ids.is_empty() || self.allowed_chat_ids.contains(&chat_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string());
        assert_eq!(config.bot_token, "123456:ABC-DEF");
        assert!(config.should_ignore_bot_messages);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string())
            .with_allowed_chat_ids(vec![12345, 67890])
            .with_ignore_bot_messages(false)
            .with_respond_only_to_mentions(true);

        assert!(!config.should_ignore_bot_messages);
        assert!(config.should_respond_only_to_mentions);
        assert_eq!(config.allowed_chat_ids.len(), 2);
    }

    #[test]
    fn test_is_chat_allowed() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string())
            .with_allowed_chat_ids(vec![12345, 67890]);

        assert!(config.is_chat_allowed(12345));
        assert!(config.is_chat_allowed(67890));
        assert!(!config.is_chat_allowed(99999));

        // Empty allowed list = all allowed
        let config_all = TelegramConfig::new("123456:ABC-DEF".to_string());
        assert!(config_all.is_chat_allowed(99999));
    }

    #[test]
    fn test_validate_valid() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_invalid() {
        let config = TelegramConfig::new("".to_string());
        assert!(config.validate().is_err());

        let config = TelegramConfig::new("invalid_token".to_string());
        assert!(config.validate().is_err());
    }
}
