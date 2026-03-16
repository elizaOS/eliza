//! Configuration types for the Copilot Proxy plugin.

use crate::error::{CopilotProxyError, Result};

/// Default base URL for the Copilot Proxy server.
pub const DEFAULT_BASE_URL: &str = "http://localhost:3000/v1";

/// Default small model for fast completions.
pub const DEFAULT_SMALL_MODEL: &str = "gpt-5-mini";

/// Default large model for capable completions.
pub const DEFAULT_LARGE_MODEL: &str = "gpt-5.1";

/// Default timeout in seconds.
pub const DEFAULT_TIMEOUT_SECONDS: u64 = 120;

/// Default maximum tokens for completions.
pub const DEFAULT_MAX_TOKENS: u32 = 8192;

/// Default context window size.
pub const DEFAULT_CONTEXT_WINDOW: u32 = 128000;

/// Available model IDs for Copilot Proxy.
pub const AVAILABLE_MODELS: &[&str] = &[
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5-mini",
    "claude-opus-4.5",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "gemini-3-pro",
    "gemini-3-flash",
    "grok-code-fast-1",
];

/// Configuration for the Copilot Proxy client.
#[derive(Debug, Clone)]
pub struct CopilotProxyConfig {
    /// Base URL for the Copilot Proxy server.
    pub base_url: String,
    /// Small model for fast completions.
    pub small_model: String,
    /// Large model for capable completions.
    pub large_model: String,
    /// Whether the plugin is enabled.
    pub enabled: bool,
    /// Request timeout in seconds.
    pub timeout_secs: u64,
    /// Maximum tokens for completions.
    pub max_tokens: u32,
    /// Context window size.
    pub context_window: u32,
}

impl Default for CopilotProxyConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl CopilotProxyConfig {
    /// Create a new configuration with default values.
    pub fn new() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            small_model: DEFAULT_SMALL_MODEL.to_string(),
            large_model: DEFAULT_LARGE_MODEL.to_string(),
            enabled: true,
            timeout_secs: DEFAULT_TIMEOUT_SECONDS,
            max_tokens: DEFAULT_MAX_TOKENS,
            context_window: DEFAULT_CONTEXT_WINDOW,
        }
    }

    /// Create configuration from environment variables.
    pub fn from_env() -> Self {
        let base_url = std::env::var("COPILOT_PROXY_BASE_URL")
            .map(|url| normalize_base_url(&url))
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());

        let small_model = std::env::var("COPILOT_PROXY_SMALL_MODEL")
            .unwrap_or_else(|_| DEFAULT_SMALL_MODEL.to_string());

        let large_model = std::env::var("COPILOT_PROXY_LARGE_MODEL")
            .unwrap_or_else(|_| DEFAULT_LARGE_MODEL.to_string());

        let enabled = std::env::var("COPILOT_PROXY_ENABLED")
            .map(|v| v.to_lowercase() != "false")
            .unwrap_or(true);

        let timeout_secs = std::env::var("COPILOT_PROXY_TIMEOUT_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS);

        let max_tokens = std::env::var("COPILOT_PROXY_MAX_TOKENS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_MAX_TOKENS);

        let context_window = std::env::var("COPILOT_PROXY_CONTEXT_WINDOW")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_CONTEXT_WINDOW);

        Self {
            base_url,
            small_model,
            large_model,
            enabled,
            timeout_secs,
            max_tokens,
            context_window,
        }
    }

    /// Set the base URL.
    pub fn base_url(mut self, url: &str) -> Self {
        self.base_url = normalize_base_url(url);
        self
    }

    /// Set the small model.
    pub fn small_model(mut self, model: &str) -> Self {
        self.small_model = model.to_string();
        self
    }

    /// Set the large model.
    pub fn large_model(mut self, model: &str) -> Self {
        self.large_model = model.to_string();
        self
    }

    /// Set whether the plugin is enabled.
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Set the timeout in seconds.
    pub fn timeout_secs(mut self, secs: u64) -> Self {
        self.timeout_secs = secs;
        self
    }

    /// Set the maximum tokens.
    pub fn max_tokens(mut self, tokens: u32) -> Self {
        self.max_tokens = tokens;
        self
    }

    /// Set the context window size.
    pub fn context_window(mut self, window: u32) -> Self {
        self.context_window = window;
        self
    }

    /// Validate the configuration.
    pub fn validate(&self) -> Result<()> {
        if self.base_url.is_empty() {
            return Err(CopilotProxyError::ConfigError(
                "Base URL cannot be empty".to_string(),
            ));
        }

        // Validate URL format
        url::Url::parse(&self.base_url)?;

        if self.small_model.is_empty() {
            return Err(CopilotProxyError::ConfigError(
                "Small model cannot be empty".to_string(),
            ));
        }

        if self.large_model.is_empty() {
            return Err(CopilotProxyError::ConfigError(
                "Large model cannot be empty".to_string(),
            ));
        }

        Ok(())
    }
}

/// Normalize a base URL to ensure it has the correct format.
pub fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return DEFAULT_BASE_URL.to_string();
    }

    let mut normalized = trimmed.trim_end_matches('/').to_string();
    if !normalized.ends_with("/v1") {
        normalized.push_str("/v1");
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_base_url() {
        assert_eq!(
            normalize_base_url("http://localhost:3000"),
            "http://localhost:3000/v1"
        );
        assert_eq!(
            normalize_base_url("http://localhost:3000/"),
            "http://localhost:3000/v1"
        );
        assert_eq!(
            normalize_base_url("http://localhost:3000/v1"),
            "http://localhost:3000/v1"
        );
        assert_eq!(
            normalize_base_url("http://localhost:3000/v1/"),
            "http://localhost:3000/v1"
        );
        assert_eq!(normalize_base_url(""), DEFAULT_BASE_URL);
    }

    #[test]
    fn test_default_config() {
        let config = CopilotProxyConfig::new();
        assert_eq!(config.base_url, DEFAULT_BASE_URL);
        assert_eq!(config.small_model, DEFAULT_SMALL_MODEL);
        assert_eq!(config.large_model, DEFAULT_LARGE_MODEL);
        assert!(config.enabled);
    }

    #[test]
    fn test_builder_methods() {
        let config = CopilotProxyConfig::new()
            .small_model("claude-haiku-4.5")
            .large_model("claude-opus-4.5")
            .enabled(false)
            .timeout_secs(30)
            .max_tokens(4096)
            .context_window(64000);

        assert_eq!(config.small_model, "claude-haiku-4.5");
        assert_eq!(config.large_model, "claude-opus-4.5");
        assert!(!config.enabled);
        assert_eq!(config.timeout_secs, 30);
        assert_eq!(config.max_tokens, 4096);
        assert_eq!(config.context_window, 64000);
    }

    #[test]
    fn test_validate_rejects_empty_base_url() {
        let config = CopilotProxyConfig {
            base_url: "".to_string(),
            ..CopilotProxyConfig::new()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_rejects_empty_small_model() {
        let config = CopilotProxyConfig {
            small_model: "".to_string(),
            ..CopilotProxyConfig::new()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_rejects_empty_large_model() {
        let config = CopilotProxyConfig {
            large_model: "".to_string(),
            ..CopilotProxyConfig::new()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_rejects_invalid_url() {
        let config = CopilotProxyConfig {
            base_url: "not a url".to_string(),
            ..CopilotProxyConfig::new()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_passes_for_valid_config() {
        let config = CopilotProxyConfig::new();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_normalize_strips_multiple_trailing_slashes() {
        assert_eq!(
            normalize_base_url("http://localhost:3000///"),
            "http://localhost:3000/v1"
        );
    }
}
