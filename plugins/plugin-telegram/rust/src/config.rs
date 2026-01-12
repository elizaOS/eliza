use serde::{Deserialize, Serialize};

use crate::error::{Result, TelegramError};

/// Configuration options for the Telegram plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    /// Bot token in the `123456:ABC-DEF...` format.
    pub bot_token: String,
    /// Optional alternate Telegram Bot API base URL (primarily for testing).
    pub api_root: Option<String>,
    /// If non-empty, only messages from these chat IDs are processed.
    pub allowed_chat_ids: Vec<i64>,
    /// Optional chat ID used by tests and example flows.
    pub test_chat_id: Option<i64>,
    /// Whether to ignore messages sent by bots.
    pub should_ignore_bot_messages: bool,
    /// Whether to respond only when the bot is explicitly mentioned.
    pub should_respond_only_to_mentions: bool,
    /// Optional bot username (without the `@`).
    pub bot_username: Option<String>,
}

impl TelegramConfig {
    /// Creates a new config with sensible defaults.
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

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `TELEGRAM_BOT_TOKEN`
    ///
    /// Optional:
    /// - `TELEGRAM_API_ROOT`
    /// - `TELEGRAM_ALLOWED_CHATS` (JSON array of `i64` chat IDs)
    /// - `TELEGRAM_TEST_CHAT_ID`
    /// - `TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES` (`true`/`false`)
    /// - `TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS` (`true`/`false`)
    /// - `TELEGRAM_BOT_USERNAME`
    pub fn from_env() -> Result<Self> {
        let bot_token = std::env::var("TELEGRAM_BOT_TOKEN")
            .map_err(|_| TelegramError::MissingSetting("TELEGRAM_BOT_TOKEN".to_string()))?;

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

    /// Sets the Telegram Bot API base URL.
    pub fn with_api_root(mut self, url: String) -> Self {
        self.api_root = Some(url);
        self
    }

    /// Sets the allowed chat IDs list (empty list means "allow all").
    pub fn with_allowed_chat_ids(mut self, ids: Vec<i64>) -> Self {
        self.allowed_chat_ids = ids;
        self
    }

    /// Sets the chat ID used by tests and example flows.
    pub fn with_test_chat_id(mut self, id: i64) -> Self {
        self.test_chat_id = Some(id);
        self
    }

    /// Sets whether bot messages should be ignored.
    pub fn with_ignore_bot_messages(mut self, ignore: bool) -> Self {
        self.should_ignore_bot_messages = ignore;
        self
    }

    /// Sets whether the bot should respond only to explicit mentions.
    pub fn with_respond_only_to_mentions(mut self, only_mentions: bool) -> Self {
        self.should_respond_only_to_mentions = only_mentions;
        self
    }

    /// Sets the bot username (without the `@`).
    pub fn with_bot_username(mut self, username: String) -> Self {
        self.bot_username = Some(username);
        self
    }

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<()> {
        if self.bot_token.is_empty() {
            return Err(TelegramError::ConfigError(
                "Bot token cannot be empty".to_string(),
            ));
        }

        if !self.bot_token.contains(':') {
            return Err(TelegramError::ConfigError(
                "Bot token format is invalid (should contain ':')".to_string(),
            ));
        }

        Ok(())
    }

    /// Returns `true` if the given chat ID is allowed by the configuration.
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
