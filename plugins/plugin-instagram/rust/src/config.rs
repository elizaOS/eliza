//! Instagram plugin configuration
//!
//! Configuration can be loaded from environment variables or constructed programmatically.

use serde::{Deserialize, Serialize};

use crate::error::{InstagramError, Result};

/// Instagram plugin configuration
///
/// Contains all settings required to connect to and operate an Instagram account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstagramConfig {
    /// Instagram username (required)
    pub username: String,

    /// Instagram password (required)
    pub password: String,

    /// Optional 2FA verification code
    pub verification_code: Option<String>,

    /// Optional proxy URL
    pub proxy: Option<String>,

    /// Whether to auto-respond to DMs
    pub auto_respond_to_dms: bool,

    /// Whether to auto-respond to comments
    pub auto_respond_to_comments: bool,

    /// Polling interval in seconds
    pub polling_interval: u64,
}

impl InstagramConfig {
    /// Create a new configuration with required fields only
    ///
    /// # Arguments
    ///
    /// * `username` - Instagram username
    /// * `password` - Instagram password
    ///
    /// # Example
    ///
    /// ```
    /// use elizaos_plugin_instagram::InstagramConfig;
    ///
    /// let config = InstagramConfig::new(
    ///     "your_username".to_string(),
    ///     "your_password".to_string(),
    /// );
    /// ```
    pub fn new(username: String, password: String) -> Self {
        Self {
            username,
            password,
            verification_code: None,
            proxy: None,
            auto_respond_to_dms: false,
            auto_respond_to_comments: false,
            polling_interval: 60,
        }
    }

    /// Load configuration from environment variables
    ///
    /// # Required Variables
    ///
    /// - `INSTAGRAM_USERNAME`: Instagram username
    /// - `INSTAGRAM_PASSWORD`: Instagram password
    ///
    /// # Optional Variables
    ///
    /// - `INSTAGRAM_VERIFICATION_CODE`: 2FA code
    /// - `INSTAGRAM_PROXY`: Proxy URL
    /// - `INSTAGRAM_AUTO_RESPOND_DMS`: "true" or "false"
    /// - `INSTAGRAM_AUTO_RESPOND_COMMENTS`: "true" or "false"
    /// - `INSTAGRAM_POLLING_INTERVAL`: Polling interval in seconds
    ///
    /// # Errors
    ///
    /// Returns `InstagramError::MissingSetting` if required variables are missing.
    pub fn from_env() -> Result<Self> {
        let username = std::env::var("INSTAGRAM_USERNAME")
            .map_err(|_| InstagramError::MissingSetting("INSTAGRAM_USERNAME".to_string()))?;

        let password = std::env::var("INSTAGRAM_PASSWORD")
            .map_err(|_| InstagramError::MissingSetting("INSTAGRAM_PASSWORD".to_string()))?;

        // Validate credentials are not empty
        if username.is_empty() {
            return Err(InstagramError::ConfigError(
                "INSTAGRAM_USERNAME cannot be empty".to_string(),
            ));
        }

        if password.is_empty() {
            return Err(InstagramError::ConfigError(
                "INSTAGRAM_PASSWORD cannot be empty".to_string(),
            ));
        }

        let verification_code = std::env::var("INSTAGRAM_VERIFICATION_CODE").ok();
        let proxy = std::env::var("INSTAGRAM_PROXY").ok();

        let auto_respond_to_dms = std::env::var("INSTAGRAM_AUTO_RESPOND_DMS")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);

        let auto_respond_to_comments = std::env::var("INSTAGRAM_AUTO_RESPOND_COMMENTS")
            .ok()
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);

        let polling_interval = std::env::var("INSTAGRAM_POLLING_INTERVAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60);

        Ok(Self {
            username,
            password,
            verification_code,
            proxy,
            auto_respond_to_dms,
            auto_respond_to_comments,
            polling_interval,
        })
    }

    /// Set verification code (builder pattern)
    pub fn with_verification_code(mut self, code: String) -> Self {
        self.verification_code = Some(code);
        self
    }

    /// Set proxy URL (builder pattern)
    pub fn with_proxy(mut self, proxy: String) -> Self {
        self.proxy = Some(proxy);
        self
    }

    /// Set auto-respond to DMs (builder pattern)
    pub fn with_auto_respond_dms(mut self, auto_respond: bool) -> Self {
        self.auto_respond_to_dms = auto_respond;
        self
    }

    /// Set auto-respond to comments (builder pattern)
    pub fn with_auto_respond_comments(mut self, auto_respond: bool) -> Self {
        self.auto_respond_to_comments = auto_respond;
        self
    }

    /// Set polling interval (builder pattern)
    pub fn with_polling_interval(mut self, seconds: u64) -> Self {
        self.polling_interval = seconds;
        self
    }

    /// Validate configuration
    pub fn validate(&self) -> Result<()> {
        if self.username.is_empty() {
            return Err(InstagramError::ConfigError(
                "Username cannot be empty".to_string(),
            ));
        }

        if self.password.is_empty() {
            return Err(InstagramError::ConfigError(
                "Password cannot be empty".to_string(),
            ));
        }

        // Username validation - should not contain special characters
        if self.username.contains('@') || self.username.contains(' ') {
            return Err(InstagramError::ConfigError(
                "Username should not contain @ or spaces".to_string(),
            ));
        }

        // Polling interval validation
        if self.polling_interval < 30 {
            return Err(InstagramError::ConfigError(
                "Polling interval must be at least 30 seconds".to_string(),
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
        assert_eq!(config.username, "testuser");
        assert_eq!(config.password, "testpass");
        assert!(!config.auto_respond_to_dms);
    }

    #[test]
    fn test_config_builder_pattern() {
        let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string())
            .with_auto_respond_dms(true)
            .with_polling_interval(120);

        assert!(config.auto_respond_to_dms);
        assert_eq!(config.polling_interval, 120);
    }

    #[test]
    fn test_validate_valid() {
        let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_empty_username() {
        let config = InstagramConfig::new("".to_string(), "testpass".to_string());
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_invalid_username() {
        let config = InstagramConfig::new("test@user".to_string(), "testpass".to_string());
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_invalid_polling() {
        let config = InstagramConfig::new("testuser".to_string(), "testpass".to_string())
            .with_polling_interval(10);
        assert!(config.validate().is_err());
    }
}
