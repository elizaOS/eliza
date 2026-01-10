//! Error types for the Farcaster plugin.

use thiserror::Error;

/// Result type alias for Farcaster operations.
pub type Result<T> = std::result::Result<T, FarcasterError>;

/// Farcaster plugin error types.
#[derive(Error, Debug)]
pub enum FarcasterError {
    /// Configuration error
    #[error("Configuration error: {0}")]
    Config(String),

    /// Validation error
    #[error("Validation error: {0}")]
    Validation(String),

    /// Network error
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    /// API error from Neynar
    #[error("API error: {message} (status: {status_code:?}, code: {error_code:?})")]
    Api {
        /// Error message
        message: String,
        /// HTTP status code
        status_code: Option<u16>,
        /// Error code from API
        error_code: Option<String>,
    },

    /// Rate limit exceeded
    #[error("Rate limit exceeded (retry after: {retry_after:?}s)")]
    RateLimit {
        /// Seconds to wait before retrying
        retry_after: Option<u64>,
    },

    /// Cast operation error
    #[error("Cast error: {0}")]
    Cast(String),

    /// Profile operation error
    #[error("Profile error: {0}")]
    Profile(String),

    /// JSON parsing error
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Environment variable error
    #[error("Environment error: {0}")]
    Env(String),

    /// Generic error
    #[error("{0}")]
    Other(String),
}

impl FarcasterError {
    /// Create a new configuration error.
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }

    /// Create a new validation error.
    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    /// Create a new API error.
    pub fn api(message: impl Into<String>, status_code: Option<u16>, error_code: Option<String>) -> Self {
        Self::Api {
            message: message.into(),
            status_code,
            error_code,
        }
    }

    /// Create a new rate limit error.
    pub fn rate_limit(retry_after: Option<u64>) -> Self {
        Self::RateLimit { retry_after }
    }

    /// Create a new cast error.
    pub fn cast(msg: impl Into<String>) -> Self {
        Self::Cast(msg.into())
    }

    /// Create a new profile error.
    pub fn profile(msg: impl Into<String>) -> Self {
        Self::Profile(msg.into())
    }

    /// Create a new environment error.
    pub fn env(msg: impl Into<String>) -> Self {
        Self::Env(msg.into())
    }

    /// Check if this is a rate limit error.
    pub fn is_rate_limit(&self) -> bool {
        matches!(self, Self::RateLimit { .. })
    }

    /// Check if this is a network error.
    pub fn is_network(&self) -> bool {
        matches!(self, Self::Network(_))
    }

    /// Check if this is a configuration error.
    pub fn is_config(&self) -> bool {
        matches!(self, Self::Config(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = FarcasterError::config("missing API key");
        assert!(err.to_string().contains("missing API key"));
        assert!(err.is_config());
    }

    #[test]
    fn test_rate_limit_error() {
        let err = FarcasterError::rate_limit(Some(60));
        assert!(err.is_rate_limit());
        assert!(err.to_string().contains("60"));
    }

    #[test]
    fn test_api_error() {
        let err = FarcasterError::api("Not found", Some(404), Some("not_found".to_string()));
        assert!(err.to_string().contains("Not found"));
        assert!(err.to_string().contains("404"));
    }
}
