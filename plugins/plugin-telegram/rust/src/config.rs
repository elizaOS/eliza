use serde::{Deserialize, Serialize};

use crate::error::{Result, TelegramError};

/// Update mode for receiving Telegram updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    /// Long-polling mode (default, suitable for development).
    #[default]
    Polling,
    /// Webhook mode (recommended for production).
    Webhook,
}

/// Configuration options for the Telegram plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    /// Bot token in the `123456:ABC-DEF...` format.
    pub bot_token: String,
    /// Optional alternate Telegram Bot API base URL (primarily for testing).
    pub api_root: Option<String>,
    /// Update mode: polling or webhook.
    pub update_mode: UpdateMode,
    /// Webhook URL (required if update_mode is webhook).
    pub webhook_url: Option<String>,
    /// Webhook path (defaults to "/telegram/webhook").
    pub webhook_path: Option<String>,
    /// Webhook port (defaults to 8443).
    pub webhook_port: Option<u16>,
    /// Webhook secret token for verification.
    pub webhook_secret: Option<String>,
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
    /// HTTP proxy URL.
    pub proxy_url: Option<String>,
    /// Whether to drop pending updates on startup.
    pub drop_pending_updates: bool,
}

impl TelegramConfig {
    /// Creates a new config with sensible defaults.
    pub fn new(bot_token: String) -> Self {
        Self {
            bot_token,
            api_root: None,
            update_mode: UpdateMode::Polling,
            webhook_url: None,
            webhook_path: Some("/telegram/webhook".to_string()),
            webhook_port: None,
            webhook_secret: None,
            allowed_chat_ids: Vec::new(),
            test_chat_id: None,
            should_ignore_bot_messages: true,
            should_respond_only_to_mentions: false,
            bot_username: None,
            proxy_url: None,
            drop_pending_updates: true,
        }
    }

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `TELEGRAM_BOT_TOKEN`
    ///
    /// Optional:
    /// - `TELEGRAM_API_ROOT`
    /// - `TELEGRAM_UPDATE_MODE` (`polling` or `webhook`)
    /// - `TELEGRAM_WEBHOOK_URL`
    /// - `TELEGRAM_WEBHOOK_PATH`
    /// - `TELEGRAM_WEBHOOK_PORT`
    /// - `TELEGRAM_WEBHOOK_SECRET`
    /// - `TELEGRAM_ALLOWED_CHATS` (JSON array of `i64` chat IDs)
    /// - `TELEGRAM_TEST_CHAT_ID`
    /// - `TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES` (`true`/`false`)
    /// - `TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS` (`true`/`false`)
    /// - `TELEGRAM_BOT_USERNAME`
    /// - `TELEGRAM_PROXY_URL`
    /// - `TELEGRAM_DROP_PENDING_UPDATES` (`true`/`false`)
    pub fn from_env() -> Result<Self> {
        let bot_token = std::env::var("TELEGRAM_BOT_TOKEN")
            .map_err(|_| TelegramError::MissingSetting("TELEGRAM_BOT_TOKEN".to_string()))?;

        if bot_token.is_empty() {
            return Err(TelegramError::ConfigError(
                "TELEGRAM_BOT_TOKEN cannot be empty".to_string(),
            ));
        }

        let api_root = std::env::var("TELEGRAM_API_ROOT").ok();

        let update_mode = std::env::var("TELEGRAM_UPDATE_MODE")
            .ok()
            .map(|s| {
                if s.to_lowercase() == "webhook" {
                    UpdateMode::Webhook
                } else {
                    UpdateMode::Polling
                }
            })
            .unwrap_or(UpdateMode::Polling);

        let webhook_url = std::env::var("TELEGRAM_WEBHOOK_URL").ok();
        let webhook_path = std::env::var("TELEGRAM_WEBHOOK_PATH")
            .ok()
            .or_else(|| Some("/telegram/webhook".to_string()));
        let webhook_port = std::env::var("TELEGRAM_WEBHOOK_PORT")
            .ok()
            .and_then(|s| s.parse().ok());
        let webhook_secret = std::env::var("TELEGRAM_WEBHOOK_SECRET").ok();

        let allowed_chat_ids = std::env::var("TELEGRAM_ALLOWED_CHATS")
            .ok()
            .and_then(|s| parse_allowed_chats(&s))
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

        let proxy_url = std::env::var("TELEGRAM_PROXY_URL").ok();

        let drop_pending_updates = std::env::var("TELEGRAM_DROP_PENDING_UPDATES")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        Ok(Self {
            bot_token,
            api_root,
            update_mode,
            webhook_url,
            webhook_path,
            webhook_port,
            webhook_secret,
            allowed_chat_ids,
            test_chat_id,
            should_ignore_bot_messages,
            should_respond_only_to_mentions,
            bot_username,
            proxy_url,
            drop_pending_updates,
        })
    }
}

/// Parse allowed chat IDs from a JSON array or comma-separated string.
fn parse_allowed_chats(value: &str) -> Option<Vec<i64>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(Vec::new());
    }

    // Try parsing as JSON array first
    if trimmed.starts_with('[') {
        if let Ok(parsed) = serde_json::from_str::<Vec<i64>>(trimmed) {
            return Some(parsed);
        }
    }

    // Otherwise parse as comma-separated
    let ids: Vec<i64> = trimmed
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    Some(ids)
}

impl TelegramConfig {
    /// Sets the Telegram Bot API base URL.
    pub fn with_api_root(mut self, url: String) -> Self {
        self.api_root = Some(url);
        self
    }

    /// Sets the update mode.
    pub fn with_update_mode(mut self, mode: UpdateMode) -> Self {
        self.update_mode = mode;
        self
    }

    /// Sets the webhook URL.
    pub fn with_webhook_url(mut self, url: String) -> Self {
        self.webhook_url = Some(url);
        self
    }

    /// Sets the webhook path.
    pub fn with_webhook_path(mut self, path: String) -> Self {
        self.webhook_path = Some(path);
        self
    }

    /// Sets the webhook port.
    pub fn with_webhook_port(mut self, port: u16) -> Self {
        self.webhook_port = Some(port);
        self
    }

    /// Sets the webhook secret.
    pub fn with_webhook_secret(mut self, secret: String) -> Self {
        self.webhook_secret = Some(secret);
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

    /// Sets the proxy URL.
    pub fn with_proxy_url(mut self, url: String) -> Self {
        self.proxy_url = Some(url);
        self
    }

    /// Sets whether to drop pending updates on startup.
    pub fn with_drop_pending_updates(mut self, drop: bool) -> Self {
        self.drop_pending_updates = drop;
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

        if self.update_mode == UpdateMode::Webhook && self.webhook_url.is_none() {
            return Err(TelegramError::ConfigError(
                "Webhook URL is required when using webhook mode".to_string(),
            ));
        }

        Ok(())
    }

    /// Returns `true` if the given chat ID is allowed by the configuration.
    pub fn is_chat_allowed(&self, chat_id: i64) -> bool {
        self.allowed_chat_ids.is_empty() || self.allowed_chat_ids.contains(&chat_id)
    }

    /// Returns the effective webhook path.
    pub fn effective_webhook_path(&self) -> &str {
        self.webhook_path.as_deref().unwrap_or("/telegram/webhook")
    }

    /// Returns the effective webhook port.
    pub fn effective_webhook_port(&self) -> u16 {
        self.webhook_port.unwrap_or(8443)
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
        assert_eq!(config.update_mode, UpdateMode::Polling);
        assert!(config.drop_pending_updates);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string())
            .with_allowed_chat_ids(vec![12345, 67890])
            .with_ignore_bot_messages(false)
            .with_respond_only_to_mentions(true)
            .with_update_mode(UpdateMode::Webhook)
            .with_webhook_url("https://example.com".to_string())
            .with_webhook_port(8443);

        assert!(!config.should_ignore_bot_messages);
        assert!(config.should_respond_only_to_mentions);
        assert_eq!(config.allowed_chat_ids.len(), 2);
        assert_eq!(config.update_mode, UpdateMode::Webhook);
        assert_eq!(config.webhook_url, Some("https://example.com".to_string()));
        assert_eq!(config.webhook_port, Some(8443));
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

    #[test]
    fn test_validate_webhook_without_url() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string())
            .with_update_mode(UpdateMode::Webhook);
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_webhook_with_url() {
        let config = TelegramConfig::new("123456:ABC-DEF".to_string())
            .with_update_mode(UpdateMode::Webhook)
            .with_webhook_url("https://example.com".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_parse_allowed_chats_json() {
        let result = parse_allowed_chats("[123, 456, 789]");
        assert_eq!(result, Some(vec![123, 456, 789]));
    }

    #[test]
    fn test_parse_allowed_chats_csv() {
        let result = parse_allowed_chats("123, 456, 789");
        assert_eq!(result, Some(vec![123, 456, 789]));
    }

    #[test]
    fn test_parse_allowed_chats_empty() {
        let result = parse_allowed_chats("");
        assert_eq!(result, Some(Vec::new()));
    }
}
