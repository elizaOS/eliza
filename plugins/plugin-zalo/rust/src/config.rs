//! Configuration types and helpers for the Zalo plugin.

use serde::{Deserialize, Serialize};

use crate::error::{Result, ZaloError};

/// Default webhook path.
pub const DEFAULT_WEBHOOK_PATH: &str = "/zalo/webhook";
/// Default webhook port.
pub const DEFAULT_WEBHOOK_PORT: u16 = 3000;

/// Configuration options for the Zalo plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloConfig {
    /// Zalo App ID.
    pub app_id: String,
    /// Zalo Secret Key.
    pub secret_key: String,
    /// OAuth access token.
    pub access_token: String,
    /// OAuth refresh token.
    pub refresh_token: Option<String>,
    /// Webhook URL (for webhook mode).
    pub webhook_url: Option<String>,
    /// Webhook path.
    pub webhook_path: Option<String>,
    /// Webhook port.
    pub webhook_port: Option<u16>,
    /// Use polling mode instead of webhooks.
    pub use_polling: bool,
    /// Whether the plugin is enabled.
    pub enabled: bool,
    /// HTTP proxy URL.
    pub proxy_url: Option<String>,
}

impl ZaloConfig {
    /// Creates a new config with required fields.
    pub fn new(app_id: String, secret_key: String, access_token: String) -> Self {
        Self {
            app_id,
            secret_key,
            access_token,
            refresh_token: None,
            webhook_url: None,
            webhook_path: Some(DEFAULT_WEBHOOK_PATH.to_string()),
            webhook_port: Some(DEFAULT_WEBHOOK_PORT),
            use_polling: false,
            enabled: true,
            proxy_url: None,
        }
    }

    /// Loads configuration from environment variables.
    ///
    /// Required:
    /// - `ZALO_APP_ID`
    /// - `ZALO_SECRET_KEY`
    /// - `ZALO_ACCESS_TOKEN`
    ///
    /// Optional:
    /// - `ZALO_REFRESH_TOKEN`
    /// - `ZALO_WEBHOOK_URL`
    /// - `ZALO_WEBHOOK_PATH`
    /// - `ZALO_WEBHOOK_PORT`
    /// - `ZALO_USE_POLLING`
    /// - `ZALO_ENABLED`
    /// - `ZALO_PROXY_URL`
    pub fn from_env() -> Result<Self> {
        let app_id = std::env::var("ZALO_APP_ID")
            .map_err(|_| ZaloError::MissingSetting("ZALO_APP_ID".to_string()))?;

        let secret_key = std::env::var("ZALO_SECRET_KEY")
            .map_err(|_| ZaloError::MissingSetting("ZALO_SECRET_KEY".to_string()))?;

        let access_token = std::env::var("ZALO_ACCESS_TOKEN")
            .map_err(|_| ZaloError::MissingSetting("ZALO_ACCESS_TOKEN".to_string()))?;

        if app_id.is_empty() {
            return Err(ZaloError::ConfigError("ZALO_APP_ID cannot be empty".to_string()));
        }

        if secret_key.is_empty() {
            return Err(ZaloError::ConfigError("ZALO_SECRET_KEY cannot be empty".to_string()));
        }

        if access_token.is_empty() {
            return Err(ZaloError::ConfigError("ZALO_ACCESS_TOKEN cannot be empty".to_string()));
        }

        let refresh_token = std::env::var("ZALO_REFRESH_TOKEN").ok();
        let webhook_url = std::env::var("ZALO_WEBHOOK_URL").ok();
        let webhook_path = std::env::var("ZALO_WEBHOOK_PATH")
            .ok()
            .or_else(|| Some(DEFAULT_WEBHOOK_PATH.to_string()));
        let webhook_port = std::env::var("ZALO_WEBHOOK_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .or(Some(DEFAULT_WEBHOOK_PORT));

        let use_polling = std::env::var("ZALO_USE_POLLING")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);

        let enabled = std::env::var("ZALO_ENABLED")
            .ok()
            .map(|s| s.to_lowercase() != "false")
            .unwrap_or(true);

        let proxy_url = std::env::var("ZALO_PROXY_URL").ok();

        Ok(Self {
            app_id,
            secret_key,
            access_token,
            refresh_token,
            webhook_url,
            webhook_path,
            webhook_port,
            use_polling,
            enabled,
            proxy_url,
        })
    }

    /// Sets the refresh token.
    pub fn with_refresh_token(mut self, token: String) -> Self {
        self.refresh_token = Some(token);
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

    /// Sets whether to use polling mode.
    pub fn with_polling(mut self, use_polling: bool) -> Self {
        self.use_polling = use_polling;
        self
    }

    /// Sets whether the plugin is enabled.
    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Sets the proxy URL.
    pub fn with_proxy_url(mut self, url: String) -> Self {
        self.proxy_url = Some(url);
        self
    }

    /// Validates the configuration.
    pub fn validate(&self) -> Result<()> {
        if self.app_id.is_empty() {
            return Err(ZaloError::ConfigError("App ID cannot be empty".to_string()));
        }

        if self.secret_key.is_empty() {
            return Err(ZaloError::ConfigError("Secret key cannot be empty".to_string()));
        }

        if self.access_token.is_empty() {
            return Err(ZaloError::ConfigError("Access token cannot be empty".to_string()));
        }

        if !self.use_polling && self.webhook_url.is_none() {
            return Err(ZaloError::ConfigError(
                "Webhook URL is required when not using polling mode".to_string(),
            ));
        }

        Ok(())
    }

    /// Returns the effective webhook path.
    pub fn effective_webhook_path(&self) -> &str {
        self.webhook_path.as_deref().unwrap_or(DEFAULT_WEBHOOK_PATH)
    }

    /// Returns the effective webhook port.
    pub fn effective_webhook_port(&self) -> u16 {
        self.webhook_port.unwrap_or(DEFAULT_WEBHOOK_PORT)
    }

    /// Returns the update mode string.
    pub fn update_mode(&self) -> &str {
        if self.use_polling {
            "polling"
        } else {
            "webhook"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = ZaloConfig::new(
            "app_id".to_string(),
            "secret_key".to_string(),
            "access_token".to_string(),
        );
        assert_eq!(config.app_id, "app_id");
        assert!(config.enabled);
        assert!(!config.use_polling);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = ZaloConfig::new(
            "app_id".to_string(),
            "secret_key".to_string(),
            "access_token".to_string(),
        )
        .with_webhook_url("https://example.com".to_string())
        .with_webhook_port(8443)
        .with_polling(true);

        assert_eq!(config.webhook_url, Some("https://example.com".to_string()));
        assert_eq!(config.webhook_port, Some(8443));
        assert!(config.use_polling);
    }

    #[test]
    fn test_validate_valid() {
        let config = ZaloConfig::new(
            "app_id".to_string(),
            "secret_key".to_string(),
            "access_token".to_string(),
        )
        .with_polling(true);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_invalid_empty_app_id() {
        let config = ZaloConfig::new(
            "".to_string(),
            "secret_key".to_string(),
            "access_token".to_string(),
        );
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_webhook_without_url() {
        let config = ZaloConfig::new(
            "app_id".to_string(),
            "secret_key".to_string(),
            "access_token".to_string(),
        );
        assert!(config.validate().is_err());
    }
}
