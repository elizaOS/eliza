use serde::{Deserialize, Serialize};

use crate::error::{FeishuError, Result};

/// API domain for Feishu (China).
pub const FEISHU_DOMAIN: &str = "https://open.feishu.cn";
/// API domain for Lark (global).
pub const LARK_DOMAIN: &str = "https://open.larksuite.com";

/// Configuration options for the Feishu plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuConfig {
    /// Application ID in the `cli_xxx` format.
    pub app_id: String,
    /// Application secret.
    pub app_secret: String,
    /// Domain: "feishu" for China or "lark" for global.
    pub domain: String,
    /// If non-empty, only messages from these chat IDs are processed.
    pub allowed_chat_ids: Vec<String>,
    /// Optional chat ID used by tests and example flows.
    pub test_chat_id: Option<String>,
    /// Whether to ignore messages sent by bots.
    pub should_ignore_bot_messages: bool,
    /// Whether to respond only when the bot is explicitly mentioned.
    pub should_respond_only_to_mentions: bool,
}

impl FeishuConfig {
    /// Creates a new config with sensible defaults.
    pub fn new(app_id: String, app_secret: String) -> Self {
        Self {
            app_id,
            app_secret,
            domain: "feishu".to_string(),
            allowed_chat_ids: Vec::new(),
            test_chat_id: None,
            should_ignore_bot_messages: true,
            should_respond_only_to_mentions: false,
        }
    }

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `FEISHU_APP_ID`
    /// - `FEISHU_APP_SECRET`
    ///
    /// Optional:
    /// - `FEISHU_DOMAIN` ("feishu" or "lark")
    /// - `FEISHU_ALLOWED_CHATS` (JSON array of chat IDs)
    /// - `FEISHU_TEST_CHAT_ID`
    /// - `FEISHU_IGNORE_BOT_MESSAGES` (`true`/`false`)
    /// - `FEISHU_RESPOND_ONLY_TO_MENTIONS` (`true`/`false`)
    pub fn from_env() -> Result<Self> {
        let app_id = std::env::var("FEISHU_APP_ID")
            .map_err(|_| FeishuError::MissingSetting("FEISHU_APP_ID".to_string()))?;

        if app_id.is_empty() {
            return Err(FeishuError::ConfigError(
                "FEISHU_APP_ID cannot be empty".to_string(),
            ));
        }

        let app_secret = std::env::var("FEISHU_APP_SECRET")
            .map_err(|_| FeishuError::MissingSetting("FEISHU_APP_SECRET".to_string()))?;

        if app_secret.is_empty() {
            return Err(FeishuError::ConfigError(
                "FEISHU_APP_SECRET cannot be empty".to_string(),
            ));
        }

        let domain = std::env::var("FEISHU_DOMAIN")
            .unwrap_or_else(|_| "feishu".to_string())
            .to_lowercase();

        let allowed_chat_ids = std::env::var("FEISHU_ALLOWED_CHATS")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let test_chat_id = std::env::var("FEISHU_TEST_CHAT_ID").ok();

        let should_ignore_bot_messages = std::env::var("FEISHU_IGNORE_BOT_MESSAGES")
            .ok()
            .map(|s| s.to_lowercase() != "false")
            .unwrap_or(true);

        let should_respond_only_to_mentions = std::env::var("FEISHU_RESPOND_ONLY_TO_MENTIONS")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);

        Ok(Self {
            app_id,
            app_secret,
            domain,
            allowed_chat_ids,
            test_chat_id,
            should_ignore_bot_messages,
            should_respond_only_to_mentions,
        })
    }

    /// Returns the API base URL for the configured domain.
    pub fn api_root(&self) -> &str {
        if self.domain == "lark" {
            LARK_DOMAIN
        } else {
            FEISHU_DOMAIN
        }
    }

    /// Sets the domain.
    pub fn with_domain(mut self, domain: String) -> Self {
        self.domain = domain;
        self
    }

    /// Sets the allowed chat IDs list (empty list means "allow all").
    pub fn with_allowed_chat_ids(mut self, ids: Vec<String>) -> Self {
        self.allowed_chat_ids = ids;
        self
    }

    /// Sets the chat ID used by tests and example flows.
    pub fn with_test_chat_id(mut self, id: String) -> Self {
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

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<()> {
        if self.app_id.is_empty() {
            return Err(FeishuError::ConfigError(
                "App ID cannot be empty".to_string(),
            ));
        }

        if !self.app_id.starts_with("cli_") {
            return Err(FeishuError::ConfigError(
                "App ID should start with 'cli_'".to_string(),
            ));
        }

        if self.app_secret.is_empty() {
            return Err(FeishuError::ConfigError(
                "App secret cannot be empty".to_string(),
            ));
        }

        if self.domain != "feishu" && self.domain != "lark" {
            return Err(FeishuError::ConfigError(
                "Domain must be 'feishu' or 'lark'".to_string(),
            ));
        }

        Ok(())
    }

    /// Returns `true` if the given chat ID is allowed by the configuration.
    pub fn is_chat_allowed(&self, chat_id: &str) -> bool {
        self.allowed_chat_ids.is_empty() || self.allowed_chat_ids.contains(&chat_id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
        assert_eq!(config.app_id, "cli_test123");
        assert_eq!(config.domain, "feishu");
        assert!(config.should_ignore_bot_messages);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
            .with_domain("lark".to_string())
            .with_allowed_chat_ids(vec!["chat1".to_string(), "chat2".to_string()])
            .with_ignore_bot_messages(false)
            .with_respond_only_to_mentions(true);

        assert_eq!(config.domain, "lark");
        assert!(!config.should_ignore_bot_messages);
        assert!(config.should_respond_only_to_mentions);
        assert_eq!(config.allowed_chat_ids.len(), 2);
    }

    #[test]
    fn test_api_root() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
        assert_eq!(config.api_root(), FEISHU_DOMAIN);

        let config = config.with_domain("lark".to_string());
        assert_eq!(config.api_root(), LARK_DOMAIN);
    }

    #[test]
    fn test_is_chat_allowed() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string())
            .with_allowed_chat_ids(vec!["chat1".to_string(), "chat2".to_string()]);

        assert!(config.is_chat_allowed("chat1"));
        assert!(config.is_chat_allowed("chat2"));
        assert!(!config.is_chat_allowed("chat3"));

        // Empty allowed list = all allowed
        let config_all = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
        assert!(config_all.is_chat_allowed("any_chat"));
    }

    #[test]
    fn test_validate_valid() {
        let config = FeishuConfig::new("cli_test123".to_string(), "secret123".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_invalid() {
        let config = FeishuConfig::new("".to_string(), "secret123".to_string());
        assert!(config.validate().is_err());

        let config = FeishuConfig::new("invalid_id".to_string(), "secret123".to_string());
        assert!(config.validate().is_err());

        let config = FeishuConfig::new("cli_test123".to_string(), "".to_string());
        assert!(config.validate().is_err());
    }
}
