use std::fmt;
use thiserror::Error;

/// Result type used throughout the Mattermost plugin.
pub type Result<T> = std::result::Result<T, MattermostError>;

#[derive(Debug, Error)]
/// Errors produced by the Mattermost plugin.
pub enum MattermostError {
    #[error("Mattermost client not initialized - call start() first")]
    /// The Mattermost client/service has not been started yet.
    ClientNotInitialized,

    #[error("Mattermost client is already running")]
    /// The Mattermost service is already running.
    AlreadyRunning,

    #[error("Failed to connect to Mattermost: {0}")]
    /// A connection attempt to Mattermost failed.
    ConnectionFailed(String),

    #[error("Mattermost API error: {0}")]
    /// A Mattermost API call failed.
    ApiError(String),

    #[error("Configuration error: {0}")]
    /// Configuration values were invalid or inconsistent.
    ConfigError(String),

    #[error("Missing required setting: {0}")]
    /// A required configuration setting was missing.
    MissingSetting(String),

    #[error("Invalid Mattermost channel ID: {0}")]
    /// A provided channel identifier was invalid.
    InvalidChannelId(String),

    #[error("Invalid argument: {0}")]
    /// A caller provided an invalid argument.
    InvalidArgument(String),

    #[error("Message too long: {length} characters (max: {max})")]
    /// A message exceeded Mattermost's maximum allowed length.
    MessageTooLong {
        /// The message length that was attempted.
        length: usize,
        /// The maximum supported length.
        max: usize,
    },

    #[error("Channel not found: {0}")]
    /// The requested channel could not be found.
    ChannelNotFound(String),

    #[error("User not found: {0}")]
    /// The requested user could not be found.
    UserNotFound(String),

    #[error("Permission denied: {0}")]
    /// The operation is not permitted.
    PermissionDenied(String),

    #[error("Rate limited by Mattermost API, retry after {retry_after_secs}s")]
    /// Mattermost API rate limit was hit.
    RateLimited {
        /// Suggested delay before retrying the request.
        retry_after_secs: u64,
    },

    #[error("Operation timed out after {timeout_ms}ms")]
    /// The operation did not complete within the expected time.
    Timeout {
        /// Timeout duration in milliseconds.
        timeout_ms: u64,
    },

    #[error("WebSocket error: {0}")]
    /// A WebSocket-related error occurred.
    WebSocketError(String),

    #[error("Internal error: {0}")]
    /// An internal error occurred.
    Internal(String),

    #[error("Serialization error: {0}")]
    /// Serialization/deserialization failed.
    SerializationError(String),

    #[error("Action validation failed: {0}")]
    /// An action failed validation.
    ValidationFailed(String),
}

impl MattermostError {
    /// Returns `true` if retrying the operation might succeed.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            MattermostError::RateLimited { .. }
                | MattermostError::Timeout { .. }
                | MattermostError::ConnectionFailed(_)
                | MattermostError::WebSocketError(_)
        )
    }

    /// Returns an optional suggested retry delay (in seconds).
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            MattermostError::RateLimited { retry_after_secs } => Some(*retry_after_secs),
            MattermostError::Timeout { timeout_ms } => Some(*timeout_ms / 2000),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for MattermostError {
    fn from(err: serde_json::Error) -> Self {
        MattermostError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for MattermostError {
    fn from(err: std::io::Error) -> Self {
        MattermostError::Internal(format!("I/O error: {}", err))
    }
}

impl From<reqwest::Error> for MattermostError {
    fn from(err: reqwest::Error) -> Self {
        MattermostError::ApiError(err.to_string())
    }
}

#[derive(Debug)]
/// Error wrapper that adds context to an underlying error.
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

/// Extension trait for attaching context strings to results.
pub trait WithContext<T, E: fmt::Display> {
    /// Maps an error into an [`ErrorContext`] produced by the given closure.
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
        let err = MattermostError::MissingSetting("MATTERMOST_BOT_TOKEN".to_string());
        assert!(err.to_string().contains("MATTERMOST_BOT_TOKEN"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(MattermostError::RateLimited {
            retry_after_secs: 10
        }
        .is_retryable());
        assert!(MattermostError::Timeout { timeout_ms: 5000 }.is_retryable());
        assert!(!MattermostError::ClientNotInitialized.is_retryable());
    }

    #[test]
    fn test_retry_after() {
        let err = MattermostError::RateLimited {
            retry_after_secs: 10,
        };
        assert_eq!(err.retry_after_secs(), Some(10));

        let err = MattermostError::ClientNotInitialized;
        assert_eq!(err.retry_after_secs(), None);
    }
}
