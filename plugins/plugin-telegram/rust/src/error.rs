//! Error types for the Telegram plugin
//!
//! Provides strongly-typed errors that fail fast with clear messages.

use std::fmt;
use thiserror::Error;

/// Result type alias for Telegram operations
pub type Result<T> = std::result::Result<T, TelegramError>;

/// Telegram plugin error types
///
/// All errors are designed to fail fast with clear, actionable messages.
/// No defensive programming or error swallowing.
#[derive(Debug, Error)]
pub enum TelegramError {
    /// Telegram client is not initialized
    #[error("Telegram client not initialized - call start() first")]
    ClientNotInitialized,

    /// Telegram client is already running
    #[error("Telegram client is already running")]
    AlreadyRunning,

    /// Failed to connect to Telegram
    #[error("Failed to connect to Telegram: {0}")]
    ConnectionFailed(String),

    /// Teloxide library error
    #[error("Telegram API error: {0}")]
    ApiError(String),

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Missing required setting
    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    /// Invalid chat ID
    #[error("Invalid Telegram chat ID: {0}")]
    InvalidChatId(String),

    /// Invalid argument
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// Message too long (over 4096 characters)
    #[error("Message too long: {length} characters (max: {max})")]
    MessageTooLong {
        /// Actual length
        length: usize,
        /// Maximum allowed
        max: usize,
    },

    /// Chat not found
    #[error("Chat not found: {0}")]
    ChatNotFound(String),

    /// User not found
    #[error("User not found: {0}")]
    UserNotFound(String),

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// Rate limited by Telegram API
    #[error("Rate limited by Telegram API, retry after {retry_after_secs}s")]
    RateLimited {
        /// Seconds until retry is allowed
        retry_after_secs: u64,
    },

    /// Timeout waiting for response
    #[error("Operation timed out after {timeout_ms}ms")]
    Timeout {
        /// Timeout in milliseconds
        timeout_ms: u64,
    },

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),

    /// Serialization/deserialization error
    #[error("Serialization error: {0}")]
    SerializationError(String),

    /// Action validation failed
    #[error("Action validation failed: {0}")]
    ValidationFailed(String),
}

impl TelegramError {
    /// Check if error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            TelegramError::RateLimited { .. }
                | TelegramError::Timeout { .. }
                | TelegramError::ConnectionFailed(_)
        )
    }

    /// Get retry delay in seconds if applicable
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            TelegramError::RateLimited { retry_after_secs } => Some(*retry_after_secs),
            TelegramError::Timeout { timeout_ms } => Some(*timeout_ms / 2000), // Half the timeout in seconds
            _ => None,
        }
    }
}

impl From<serde_json::Error> for TelegramError {
    fn from(err: serde_json::Error) -> Self {
        TelegramError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for TelegramError {
    fn from(err: std::io::Error) -> Self {
        TelegramError::Internal(format!("I/O error: {}", err))
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

/// Extension trait for adding context to errors
pub trait WithContext<T, E: fmt::Display> {
    /// Add context to an error
    fn with_context<F: FnOnce() -> String>(self, f: F) -> std::result::Result<T, ErrorContext<E>>;
}

impl<T, E: fmt::Display> WithContext<T, E> for std::result::Result<T, E> {
    fn with_context<F: FnOnce() -> String>(self, f: F) -> std::result::Result<T, ErrorContext<E>> {
        self.map_err(|e| ErrorContext {
            error: e,
            context: f(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = TelegramError::MissingSetting("TELEGRAM_BOT_TOKEN".to_string());
        assert!(err.to_string().contains("TELEGRAM_BOT_TOKEN"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(TelegramError::RateLimited { retry_after_secs: 10 }.is_retryable());
        assert!(TelegramError::Timeout { timeout_ms: 5000 }.is_retryable());
        assert!(!TelegramError::ClientNotInitialized.is_retryable());
    }

    #[test]
    fn test_retry_after() {
        let err = TelegramError::RateLimited { retry_after_secs: 10 };
        assert_eq!(err.retry_after_secs(), Some(10));

        let err = TelegramError::ClientNotInitialized;
        assert_eq!(err.retry_after_secs(), None);
    }
}
