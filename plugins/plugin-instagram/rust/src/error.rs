//! Error types for the Instagram plugin
//!
//! Provides strongly-typed errors that fail fast with clear messages.

use std::fmt;
use thiserror::Error;

/// Result type alias for Instagram operations
pub type Result<T> = std::result::Result<T, InstagramError>;

/// Instagram plugin error types
///
/// All errors are designed to fail fast with clear, actionable messages.
#[derive(Debug, Error)]
pub enum InstagramError {
    /// Instagram client is not initialized
    #[error("Instagram client not initialized - call start() first")]
    ClientNotInitialized,

    /// Instagram client is already running
    #[error("Instagram client is already running")]
    AlreadyRunning,

    /// Failed to connect to Instagram
    #[error("Failed to connect to Instagram: {0}")]
    ConnectionFailed(String),

    /// Authentication failed
    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    /// Two-factor authentication required
    #[error("Two-factor authentication required")]
    TwoFactorRequired,

    /// Challenge required (e.g., suspicious login)
    #[error("Challenge required: {0}")]
    ChallengeRequired(String),

    /// API error from Instagram
    #[error("Instagram API error: {0}")]
    ApiError(String),

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Missing required setting
    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    /// Invalid user ID
    #[error("Invalid Instagram user ID: {0}")]
    InvalidUserId(String),

    /// Invalid argument
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// Message/caption too long
    #[error("Content too long: {length} characters (max: {max})")]
    ContentTooLong {
        /// Actual length
        length: usize,
        /// Maximum allowed
        max: usize,
    },

    /// User not found
    #[error("User not found: {0}")]
    UserNotFound(String),

    /// Media not found
    #[error("Media not found: {0}")]
    MediaNotFound(String),

    /// Thread not found
    #[error("Thread not found: {0}")]
    ThreadNotFound(String),

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// Rate limited by Instagram
    #[error("Rate limited by Instagram, retry after {retry_after_secs}s")]
    RateLimited {
        /// Seconds until retry is allowed
        retry_after_secs: u64,
    },

    /// Account blocked
    #[error("Account temporarily blocked: {0}")]
    AccountBlocked(String),

    /// Timeout waiting for response
    #[error("Operation timed out after {timeout_ms}ms")]
    Timeout {
        /// Timeout in milliseconds
        timeout_ms: u64,
    },

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),

    /// Serialization error
    #[error("Serialization error: {0}")]
    SerializationError(String),

    /// Action validation failed
    #[error("Action validation failed: {0}")]
    ValidationFailed(String),

    /// HTTP error
    #[error("HTTP error: {0}")]
    HttpError(String),
}

impl InstagramError {
    /// Check if error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            InstagramError::RateLimited { .. }
                | InstagramError::Timeout { .. }
                | InstagramError::ConnectionFailed(_)
        )
    }

    /// Get retry delay in seconds if applicable
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            InstagramError::RateLimited { retry_after_secs } => Some(*retry_after_secs),
            InstagramError::Timeout { timeout_ms } => Some(*timeout_ms / 2000),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for InstagramError {
    fn from(err: serde_json::Error) -> Self {
        InstagramError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for InstagramError {
    fn from(err: std::io::Error) -> Self {
        InstagramError::Internal(format!("I/O error: {}", err))
    }
}

impl From<reqwest::Error> for InstagramError {
    fn from(err: reqwest::Error) -> Self {
        InstagramError::HttpError(err.to_string())
    }
}

/// Error context wrapper for adding contextual information
#[derive(Debug)]
pub struct ErrorContext<E: fmt::Display> {
    error: E,
    context: String,
}

impl<E: fmt::Display> fmt::Display for ErrorContext<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.context, self.error)
    }
}

impl<E: fmt::Display + fmt::Debug> std::error::Error for ErrorContext<E> {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = InstagramError::MissingSetting("INSTAGRAM_USERNAME".to_string());
        assert!(err.to_string().contains("INSTAGRAM_USERNAME"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(InstagramError::RateLimited { retry_after_secs: 60 }.is_retryable());
        assert!(InstagramError::Timeout { timeout_ms: 5000 }.is_retryable());
        assert!(!InstagramError::ClientNotInitialized.is_retryable());
    }

    #[test]
    fn test_retry_after() {
        let err = InstagramError::RateLimited { retry_after_secs: 60 };
        assert_eq!(err.retry_after_secs(), Some(60));

        let err = InstagramError::ClientNotInitialized;
        assert_eq!(err.retry_after_secs(), None);
    }
}
