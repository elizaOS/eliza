use serde::{Deserialize, Serialize};

use crate::error::{GmailWatchError, Result};

/// Default bind address for the Pub/Sub push receiver.
pub const DEFAULT_BIND: &str = "127.0.0.1";
/// Default port for the Pub/Sub push receiver.
pub const DEFAULT_PORT: u16 = 8788;
/// Default path for the Pub/Sub push receiver.
pub const DEFAULT_PATH: &str = "/gmail-pubsub";
/// Default renewal interval in minutes (6 hours).
pub const DEFAULT_RENEW_MINUTES: u32 = 360;
/// Default maximum bytes for message bodies.
pub const DEFAULT_MAX_BYTES: u32 = 20000;
/// Default hook URL for forwarding Gmail events.
pub const DEFAULT_HOOK_URL: &str = "http://127.0.0.1:18789/hooks/gmail";

/// Configuration for the local Pub/Sub push receiver.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServeConfig {
    /// Bind address (e.g. `"127.0.0.1"`).
    pub bind: String,
    /// Port number.
    pub port: u16,
    /// URL path (e.g. `"/gmail-pubsub"`).
    pub path: String,
}

impl Default for ServeConfig {
    fn default() -> Self {
        Self {
            bind: DEFAULT_BIND.to_string(),
            port: DEFAULT_PORT,
            path: DEFAULT_PATH.to_string(),
        }
    }
}

/// Configuration for the Gmail Watch service.
///
/// This is resolved from the character settings at `hooks.gmail.*`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GmailWatchConfig {
    /// Gmail account address.
    pub account: String,
    /// Gmail label to watch (default: `"INBOX"`).
    pub label: String,
    /// Pub/Sub topic name.
    pub topic: String,
    /// Optional Pub/Sub subscription name.
    pub subscription: Option<String>,
    /// Push token for verifying Pub/Sub messages.
    pub push_token: String,
    /// URL to forward Gmail events to.
    pub hook_url: String,
    /// Bearer token for the hook endpoint.
    pub hook_token: String,
    /// Whether to include the message body.
    pub include_body: bool,
    /// Maximum bytes for message bodies.
    pub max_bytes: u32,
    /// Renewal interval in minutes.
    pub renew_every_minutes: u32,
    /// Configuration for the local push receiver.
    pub serve: ServeConfig,
}

impl GmailWatchConfig {
    /// Creates a new config with the given account and sensible defaults.
    pub fn new(account: String) -> Self {
        Self {
            account,
            label: "INBOX".to_string(),
            topic: String::new(),
            subscription: None,
            push_token: String::new(),
            hook_url: DEFAULT_HOOK_URL.to_string(),
            hook_token: String::new(),
            include_body: true,
            max_bytes: DEFAULT_MAX_BYTES,
            renew_every_minutes: DEFAULT_RENEW_MINUTES,
            serve: ServeConfig::default(),
        }
    }

    /// Builder: sets the label.
    pub fn with_label(mut self, label: String) -> Self {
        self.label = label;
        self
    }

    /// Builder: sets the topic.
    pub fn with_topic(mut self, topic: String) -> Self {
        self.topic = topic;
        self
    }

    /// Builder: sets the hook token.
    pub fn with_hook_token(mut self, token: String) -> Self {
        self.hook_token = token;
        self
    }

    /// Builder: sets the hook URL.
    pub fn with_hook_url(mut self, url: String) -> Self {
        self.hook_url = url;
        self
    }

    /// Builder: sets the push token.
    pub fn with_push_token(mut self, token: String) -> Self {
        self.push_token = token;
        self
    }

    /// Builder: sets include_body.
    pub fn with_include_body(mut self, include: bool) -> Self {
        self.include_body = include;
        self
    }

    /// Builder: sets max_bytes.
    pub fn with_max_bytes(mut self, bytes: u32) -> Self {
        self.max_bytes = bytes;
        self
    }

    /// Builder: sets the renewal interval in minutes.
    pub fn with_renew_every_minutes(mut self, minutes: u32) -> Self {
        self.renew_every_minutes = minutes;
        self
    }

    /// Builder: sets the serve configuration.
    pub fn with_serve(mut self, serve: ServeConfig) -> Self {
        self.serve = serve;
        self
    }

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<()> {
        if self.account.is_empty() {
            return Err(GmailWatchError::ConfigError(
                "Account cannot be empty".to_string(),
            ));
        }

        if self.account.trim().is_empty() {
            return Err(GmailWatchError::ConfigError(
                "Account cannot be blank".to_string(),
            ));
        }

        if self.renew_every_minutes == 0 {
            return Err(GmailWatchError::ConfigError(
                "renew_every_minutes must be positive".to_string(),
            ));
        }

        if self.serve.port == 0 {
            return Err(GmailWatchError::ConfigError(
                "serve.port must be between 1 and 65535".to_string(),
            ));
        }

        Ok(())
    }

    /// Resolves a [`GmailWatchConfig`] from a JSON settings object.
    ///
    /// Expected layout:
    /// ```json
    /// { "hooks": { "token": "...", "gmail": { "account": "...", ... } } }
    /// ```
    ///
    /// Returns `None` when `hooks.gmail.account` is not configured.
    pub fn from_settings(settings: &serde_json::Value) -> Option<Self> {
        let hooks = settings.get("hooks")?.as_object()?;
        let gmail = hooks.get("gmail")?.as_object()?;

        let account = gmail
            .get("account")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        if account.is_empty() {
            return None;
        }

        let hooks_token = hooks
            .get("token")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();

        let serve_obj = gmail.get("serve").and_then(|v| v.as_object());

        let serve = ServeConfig {
            bind: serve_obj
                .and_then(|s| s.get("bind"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| DEFAULT_BIND.to_string()),
            port: serve_obj
                .and_then(|s| s.get("port"))
                .and_then(|v| v.as_u64())
                .map(|p| p as u16)
                .unwrap_or(DEFAULT_PORT),
            path: serve_obj
                .and_then(|s| s.get("path"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| DEFAULT_PATH.to_string()),
        };

        Some(Self {
            account,
            label: gmail
                .get("label")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "INBOX".to_string()),
            topic: gmail
                .get("topic")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default(),
            subscription: gmail
                .get("subscription")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            push_token: gmail
                .get("pushToken")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default(),
            hook_url: gmail
                .get("hookUrl")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| DEFAULT_HOOK_URL.to_string()),
            hook_token: hooks_token,
            include_body: gmail
                .get("includeBody")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            max_bytes: gmail
                .get("maxBytes")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .unwrap_or(DEFAULT_MAX_BYTES),
            renew_every_minutes: gmail
                .get("renewEveryMinutes")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .unwrap_or(DEFAULT_RENEW_MINUTES),
            serve,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = GmailWatchConfig::new("user@gmail.com".to_string());
        assert_eq!(config.account, "user@gmail.com");
        assert_eq!(config.label, "INBOX");
        assert!(config.include_body);
        assert_eq!(config.renew_every_minutes, DEFAULT_RENEW_MINUTES);
        assert_eq!(config.max_bytes, DEFAULT_MAX_BYTES);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = GmailWatchConfig::new("user@gmail.com".to_string())
            .with_label("STARRED".to_string())
            .with_topic("projects/p/topics/t".to_string())
            .with_hook_token("secret".to_string())
            .with_renew_every_minutes(30)
            .with_include_body(false);

        assert_eq!(config.label, "STARRED");
        assert_eq!(config.topic, "projects/p/topics/t");
        assert_eq!(config.hook_token, "secret");
        assert_eq!(config.renew_every_minutes, 30);
        assert!(!config.include_body);
    }

    #[test]
    fn test_serve_config_defaults() {
        let serve = ServeConfig::default();
        assert_eq!(serve.bind, DEFAULT_BIND);
        assert_eq!(serve.port, DEFAULT_PORT);
        assert_eq!(serve.path, DEFAULT_PATH);
    }

    #[test]
    fn test_validate_valid() {
        let config = GmailWatchConfig::new("user@gmail.com".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_empty_account() {
        let config = GmailWatchConfig::new("".to_string());
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("empty"));
    }

    #[test]
    fn test_validate_blank_account() {
        let config = GmailWatchConfig::new("   ".to_string());
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("blank"));
    }

    #[test]
    fn test_validate_zero_renew() {
        let config = GmailWatchConfig::new("a@b.com".to_string()).with_renew_every_minutes(0);
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_zero_port() {
        let config = GmailWatchConfig::new("a@b.com".to_string()).with_serve(ServeConfig {
            port: 0,
            ..ServeConfig::default()
        });
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_from_settings_full() {
        let settings = serde_json::json!({
            "hooks": {
                "enabled": true,
                "token": "shared-secret",
                "gmail": {
                    "account": "user@gmail.com",
                    "label": "INBOX",
                    "topic": "projects/p/topics/t",
                    "pushToken": "push-tok",
                    "hookUrl": "http://localhost:18789/hooks/gmail",
                    "includeBody": true,
                    "maxBytes": 20000,
                    "renewEveryMinutes": 360,
                    "serve": {
                        "bind": "127.0.0.1",
                        "port": 8788,
                        "path": "/gmail-pubsub"
                    }
                }
            }
        });

        let config = GmailWatchConfig::from_settings(&settings).unwrap();
        assert_eq!(config.account, "user@gmail.com");
        assert_eq!(config.label, "INBOX");
        assert_eq!(config.topic, "projects/p/topics/t");
        assert_eq!(config.push_token, "push-tok");
        assert_eq!(config.hook_token, "shared-secret");
        assert!(config.include_body);
        assert_eq!(config.max_bytes, 20000);
        assert_eq!(config.renew_every_minutes, 360);
        assert_eq!(config.serve.port, 8788);
    }

    #[test]
    fn test_from_settings_missing_hooks() {
        let settings = serde_json::json!({});
        assert!(GmailWatchConfig::from_settings(&settings).is_none());
    }

    #[test]
    fn test_from_settings_missing_gmail() {
        let settings = serde_json::json!({"hooks": {}});
        assert!(GmailWatchConfig::from_settings(&settings).is_none());
    }

    #[test]
    fn test_from_settings_missing_account() {
        let settings = serde_json::json!({"hooks": {"gmail": {}}});
        assert!(GmailWatchConfig::from_settings(&settings).is_none());
    }

    #[test]
    fn test_from_settings_empty_account() {
        let settings = serde_json::json!({"hooks": {"gmail": {"account": ""}}});
        assert!(GmailWatchConfig::from_settings(&settings).is_none());
    }

    #[test]
    fn test_from_settings_minimal() {
        let settings = serde_json::json!({"hooks": {"gmail": {"account": "me@x.com"}}});
        let config = GmailWatchConfig::from_settings(&settings).unwrap();
        assert_eq!(config.account, "me@x.com");
        assert_eq!(config.label, "INBOX");
        assert_eq!(config.renew_every_minutes, DEFAULT_RENEW_MINUTES);
        assert_eq!(config.serve.port, DEFAULT_PORT);
    }

    #[test]
    fn test_from_settings_include_body_false() {
        let settings = serde_json::json!({
            "hooks": {"gmail": {"account": "a@b.com", "includeBody": false}}
        });
        let config = GmailWatchConfig::from_settings(&settings).unwrap();
        assert!(!config.include_body);
    }
}
