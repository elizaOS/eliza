use serde::{Deserialize, Serialize};

use crate::error::{NextcloudTalkError, Result};

/// Configuration options for the Nextcloud Talk plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextcloudTalkConfig {
    /// Base URL of the Nextcloud instance (e.g., "https://cloud.example.com").
    pub base_url: String,
    /// Bot shared secret from occ talk:bot:install output.
    pub bot_secret: String,
    /// Whether the plugin is enabled.
    pub enabled: bool,
    /// Webhook server port.
    pub webhook_port: u16,
    /// Webhook server host.
    pub webhook_host: String,
    /// Webhook endpoint path.
    pub webhook_path: String,
    /// Public URL for the webhook (used if behind reverse proxy).
    pub webhook_public_url: Option<String>,
    /// Allowlist of room tokens (empty = allow all).
    pub allowed_rooms: Vec<String>,
}

impl NextcloudTalkConfig {
    /// Creates a new config with sensible defaults.
    pub fn new(base_url: String, bot_secret: String) -> Self {
        Self {
            base_url,
            bot_secret,
            enabled: true,
            webhook_port: 8788,
            webhook_host: "0.0.0.0".to_string(),
            webhook_path: "/nextcloud-talk-webhook".to_string(),
            webhook_public_url: None,
            allowed_rooms: Vec::new(),
        }
    }

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `NEXTCLOUD_URL`
    /// - `NEXTCLOUD_BOT_SECRET`
    ///
    /// Optional:
    /// - `NEXTCLOUD_ENABLED` (`true`/`false`)
    /// - `NEXTCLOUD_WEBHOOK_PORT`
    /// - `NEXTCLOUD_WEBHOOK_HOST`
    /// - `NEXTCLOUD_WEBHOOK_PATH`
    /// - `NEXTCLOUD_WEBHOOK_PUBLIC_URL`
    /// - `NEXTCLOUD_ALLOWED_ROOMS` (JSON array or comma-separated)
    pub fn from_env() -> Result<Self> {
        let base_url = std::env::var("NEXTCLOUD_URL")
            .map_err(|_| NextcloudTalkError::MissingSetting("NEXTCLOUD_URL".to_string()))?;

        if base_url.is_empty() {
            return Err(NextcloudTalkError::ConfigError(
                "NEXTCLOUD_URL cannot be empty".to_string(),
            ));
        }

        let bot_secret = std::env::var("NEXTCLOUD_BOT_SECRET")
            .map_err(|_| NextcloudTalkError::MissingSetting("NEXTCLOUD_BOT_SECRET".to_string()))?;

        if bot_secret.is_empty() {
            return Err(NextcloudTalkError::ConfigError(
                "NEXTCLOUD_BOT_SECRET cannot be empty".to_string(),
            ));
        }

        let enabled = std::env::var("NEXTCLOUD_ENABLED")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true);

        let webhook_port = std::env::var("NEXTCLOUD_WEBHOOK_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8788);

        let webhook_host = std::env::var("NEXTCLOUD_WEBHOOK_HOST")
            .ok()
            .unwrap_or_else(|| "0.0.0.0".to_string());

        let webhook_path = std::env::var("NEXTCLOUD_WEBHOOK_PATH")
            .ok()
            .unwrap_or_else(|| "/nextcloud-talk-webhook".to_string());

        let webhook_public_url = std::env::var("NEXTCLOUD_WEBHOOK_PUBLIC_URL").ok();

        let allowed_rooms = std::env::var("NEXTCLOUD_ALLOWED_ROOMS")
            .ok()
            .map(|s| parse_allowed_rooms(&s))
            .unwrap_or_default();

        Ok(Self {
            base_url,
            bot_secret,
            enabled,
            webhook_port,
            webhook_host,
            webhook_path,
            webhook_public_url,
            allowed_rooms,
        })
    }

    /// Sets the webhook port.
    pub fn with_webhook_port(mut self, port: u16) -> Self {
        self.webhook_port = port;
        self
    }

    /// Sets the webhook host.
    pub fn with_webhook_host(mut self, host: String) -> Self {
        self.webhook_host = host;
        self
    }

    /// Sets the webhook path.
    pub fn with_webhook_path(mut self, path: String) -> Self {
        self.webhook_path = path;
        self
    }

    /// Sets the allowed rooms list.
    pub fn with_allowed_rooms(mut self, rooms: Vec<String>) -> Self {
        self.allowed_rooms = rooms;
        self
    }

    /// Enables or disables the plugin.
    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Validates the configuration values.
    pub fn validate(&self) -> Result<()> {
        if self.base_url.is_empty() {
            return Err(NextcloudTalkError::ConfigError(
                "Base URL cannot be empty".to_string(),
            ));
        }

        if self.bot_secret.is_empty() {
            return Err(NextcloudTalkError::ConfigError(
                "Bot secret cannot be empty".to_string(),
            ));
        }

        if !self.base_url.starts_with("http://") && !self.base_url.starts_with("https://") {
            return Err(NextcloudTalkError::ConfigError(
                "Base URL must start with http:// or https://".to_string(),
            ));
        }

        Ok(())
    }

    /// Returns `true` if the given room token is allowed by the configuration.
    pub fn is_room_allowed(&self, room_token: &str) -> bool {
        self.allowed_rooms.is_empty() || self.allowed_rooms.contains(&room_token.to_string())
    }
}

/// Parse allowed rooms from a JSON array or comma-separated string.
fn parse_allowed_rooms(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    // Try parsing as JSON array first
    if trimmed.starts_with('[') {
        if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
            return parsed;
        }
    }

    // Otherwise parse as comma-separated
    trimmed
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "secret123".to_string(),
        );
        assert_eq!(config.base_url, "https://cloud.example.com");
        assert!(config.enabled);
        assert_eq!(config.webhook_port, 8788);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "secret123".to_string(),
        )
        .with_webhook_port(9999)
        .with_allowed_rooms(vec!["room1".to_string(), "room2".to_string()])
        .with_enabled(false);

        assert!(!config.enabled);
        assert_eq!(config.webhook_port, 9999);
        assert_eq!(config.allowed_rooms.len(), 2);
    }

    #[test]
    fn test_is_room_allowed() {
        let config = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "secret123".to_string(),
        )
        .with_allowed_rooms(vec!["room1".to_string(), "room2".to_string()]);

        assert!(config.is_room_allowed("room1"));
        assert!(config.is_room_allowed("room2"));
        assert!(!config.is_room_allowed("room3"));

        // Empty allowed list = all allowed
        let config_all = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "secret123".to_string(),
        );
        assert!(config_all.is_room_allowed("any_room"));
    }

    #[test]
    fn test_validate_valid() {
        let config = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "secret123".to_string(),
        );
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_invalid() {
        let config = NextcloudTalkConfig::new("".to_string(), "secret123".to_string());
        assert!(config.validate().is_err());

        let config = NextcloudTalkConfig::new(
            "https://cloud.example.com".to_string(),
            "".to_string(),
        );
        assert!(config.validate().is_err());

        let config = NextcloudTalkConfig::new(
            "cloud.example.com".to_string(),
            "secret123".to_string(),
        );
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_parse_allowed_rooms() {
        assert_eq!(parse_allowed_rooms(""), Vec::<String>::new());
        assert_eq!(
            parse_allowed_rooms("room1,room2,room3"),
            vec!["room1", "room2", "room3"]
        );
        assert_eq!(
            parse_allowed_rooms(r#"["room1", "room2"]"#),
            vec!["room1", "room2"]
        );
    }
}
