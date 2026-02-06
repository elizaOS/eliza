//! ACP client configuration

use crate::error::{AcpError, Result};
use std::time::Duration;

/// Default timeout in seconds
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Default API version
const DEFAULT_API_VERSION: &str = "2026-01-30";

/// ACP client configuration
#[derive(Debug, Clone)]
pub struct AcpClientConfig {
    /// Merchant base URL
    pub base_url: String,
    /// API key for authentication
    pub api_key: Option<String>,
    /// Request timeout
    pub timeout: Duration,
    /// API version
    pub api_version: String,
    /// User agent
    pub user_agent: String,
}

impl Default for AcpClientConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            api_key: None,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
            api_version: DEFAULT_API_VERSION.to_string(),
            user_agent: format!("elizaos-plugin-acp/{}", crate::PLUGIN_VERSION),
        }
    }
}

impl AcpClientConfig {
    /// Create a new configuration with the given base URL
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            ..Default::default()
        }
    }

    /// Create configuration from environment variables
    ///
    /// Environment variables:
    /// - `ACP_MERCHANT_BASE_URL` (required): Merchant API base URL
    /// - `ACP_MERCHANT_API_KEY` (optional): API key for authentication
    /// - `ACP_REQUEST_TIMEOUT` (optional): Request timeout in seconds
    /// - `ACP_API_VERSION` (optional): API version
    ///
    /// # Errors
    ///
    /// Returns `AcpError::MissingConfig` if `ACP_MERCHANT_BASE_URL` is not set.
    pub fn from_env() -> Result<Self> {
        let base_url = std::env::var("ACP_MERCHANT_BASE_URL")
            .map_err(|_| AcpError::MissingConfig("ACP_MERCHANT_BASE_URL".to_string()))?;

        let api_key = std::env::var("ACP_MERCHANT_API_KEY").ok();

        let timeout = std::env::var("ACP_REQUEST_TIMEOUT")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or(Duration::from_secs(DEFAULT_TIMEOUT_SECS));

        let api_version = std::env::var("ACP_API_VERSION")
            .unwrap_or_else(|_| DEFAULT_API_VERSION.to_string());

        Ok(Self {
            base_url,
            api_key,
            timeout,
            api_version,
            ..Default::default()
        })
    }

    /// Set the API key
    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    /// Set the request timeout
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Set the API version
    pub fn with_api_version(mut self, version: impl Into<String>) -> Self {
        self.api_version = version.into();
        self
    }

    /// Set the user agent
    pub fn with_user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = user_agent.into();
        self
    }

    /// Validate the configuration
    pub fn validate(&self) -> Result<()> {
        if self.base_url.is_empty() {
            return Err(AcpError::MissingConfig("base_url is empty".to_string()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AcpClientConfig::default();
        assert!(config.base_url.is_empty());
        assert!(config.api_key.is_none());
        assert_eq!(config.timeout, Duration::from_secs(DEFAULT_TIMEOUT_SECS));
        assert_eq!(config.api_version, DEFAULT_API_VERSION);
    }

    #[test]
    fn test_new_config() {
        let config = AcpClientConfig::new("https://api.merchant.com");
        assert_eq!(config.base_url, "https://api.merchant.com");
    }

    #[test]
    fn test_builder_pattern() {
        let config = AcpClientConfig::new("https://api.merchant.com")
            .with_api_key("test_key")
            .with_timeout(Duration::from_secs(60))
            .with_api_version("2025-01-01");

        assert_eq!(config.base_url, "https://api.merchant.com");
        assert_eq!(config.api_key, Some("test_key".to_string()));
        assert_eq!(config.timeout, Duration::from_secs(60));
        assert_eq!(config.api_version, "2025-01-01");
    }

    #[test]
    fn test_validate_empty_url() {
        let config = AcpClientConfig::default();
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_valid_config() {
        let config = AcpClientConfig::new("https://api.merchant.com");
        assert!(config.validate().is_ok());
    }
}
