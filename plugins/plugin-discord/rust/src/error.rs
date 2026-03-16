//! Error types for the Discord plugin
//!
//! Provides strongly-typed errors that fail fast with clear messages.

use std::fmt;
use thiserror::Error;

/// Result type alias for Discord operations
pub type Result<T> = std::result::Result<T, DiscordError>;

/// Discord plugin error types
///
/// All errors are designed to fail fast with clear, actionable messages.
/// No defensive programming or error swallowing.
#[derive(Debug, Error)]
pub enum DiscordError {
    /// Discord client is not initialized
    #[error("Discord client not initialized - call start() first")]
    ClientNotInitialized,

    /// Discord client is already running
    #[error("Discord client is already running")]
    AlreadyRunning,

    /// Failed to connect to Discord
    #[error("Failed to connect to Discord: {0}")]
    ConnectionFailed(String),

    /// Serenity library error
    #[cfg(feature = "native")]
    #[error("Discord API error: {0}")]
    SerenityError(#[from] serenity::Error),

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Missing required setting
    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    /// Invalid snowflake ID
    #[error("Invalid Discord snowflake: {0}")]
    InvalidSnowflake(String),

    /// Invalid argument
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// Message too long (over 2000 characters and cannot be split)
    #[error("Message too long: {length} characters (max: {max})")]
    MessageTooLong {
        /// Actual length
        length: usize,
        /// Maximum allowed
        max: usize,
    },

    /// Channel not found
    #[error("Channel not found: {0}")]
    ChannelNotFound(String),

    /// Guild not found
    #[error("Guild not found: {0}")]
    GuildNotFound(String),

    /// User not found
    #[error("User not found: {0}")]
    UserNotFound(String),

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// Rate limited by Discord API
    #[error("Rate limited by Discord API, retry after {retry_after_ms}ms")]
    RateLimited {
        /// Milliseconds until retry is allowed
        retry_after_ms: u64,
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

impl DiscordError {
    /// Check if error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            DiscordError::RateLimited { .. }
                | DiscordError::Timeout { .. }
                | DiscordError::ConnectionFailed(_)
        )
    }

    /// Get retry delay in milliseconds if applicable
    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            DiscordError::RateLimited { retry_after_ms } => Some(*retry_after_ms),
            DiscordError::Timeout { timeout_ms } => Some(*timeout_ms / 2), // Half the timeout
            _ => None,
        }
    }
}

impl From<serde_json::Error> for DiscordError {
    fn from(err: serde_json::Error) -> Self {
        DiscordError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for DiscordError {
    fn from(err: std::io::Error) -> Self {
        DiscordError::Internal(format!("I/O error: {}", err))
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
        let err = DiscordError::MissingSetting("DISCORD_API_TOKEN".to_string());
        assert!(err.to_string().contains("DISCORD_API_TOKEN"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(DiscordError::RateLimited {
            retry_after_ms: 1000
        }
        .is_retryable());
        assert!(DiscordError::Timeout { timeout_ms: 5000 }.is_retryable());
        assert!(!DiscordError::ClientNotInitialized.is_retryable());
    }

    #[test]
    fn test_retry_after() {
        let err = DiscordError::RateLimited {
            retry_after_ms: 1000,
        };
        assert_eq!(err.retry_after_ms(), Some(1000));

        let err = DiscordError::ClientNotInitialized;
        assert_eq!(err.retry_after_ms(), None);
    }
}
