use std::fmt;
use thiserror::Error;

/// Result type used throughout the Feishu plugin.
pub type Result<T> = std::result::Result<T, FeishuError>;

#[derive(Debug, Error)]
/// Errors produced by the Feishu plugin.
pub enum FeishuError {
    #[error("Feishu client not initialized - call start() first")]
    /// The Feishu client/service has not been started yet.
    ClientNotInitialized,

    #[error("Feishu client is already running")]
    /// The Feishu service is already running.
    AlreadyRunning,

    #[error("Failed to connect to Feishu: {0}")]
    /// A connection attempt to Feishu failed.
    ConnectionFailed(String),

    #[error("Feishu API error: {0}")]
    /// A Feishu API call failed.
    ApiError(String),

    #[error("Configuration error: {0}")]
    /// Configuration values were invalid or inconsistent.
    ConfigError(String),

    #[error("Missing required setting: {0}")]
    /// A required configuration setting was missing.
    MissingSetting(String),

    #[error("Invalid Feishu chat ID: {0}")]
    /// A provided chat identifier was invalid.
    InvalidChatId(String),

    #[error("Invalid argument: {0}")]
    /// A caller provided an invalid argument.
    InvalidArgument(String),

    #[error("Message too long: {length} characters (max: {max})")]
    /// A message exceeded Feishu's maximum allowed length.
    MessageTooLong {
        /// The message length that was attempted.
        length: usize,
        /// The maximum supported length.
        max: usize,
    },

    #[error("Chat not found: {0}")]
    /// The requested chat could not be found.
    ChatNotFound(String),

    #[error("User not found: {0}")]
    /// The requested user could not be found.
    UserNotFound(String),

    #[error("Permission denied: {0}")]
    /// The operation is not permitted.
    PermissionDenied(String),

    #[error("Rate limited by Feishu API, retry after {retry_after_secs}s")]
    /// Feishu API rate limit was hit.
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
    /// A WebSocket operation failed.
    WebSocketError(String),

    #[error("Authentication error: {0}")]
    /// Authentication failed.
    AuthenticationError(String),

    #[error("Token expired")]
    /// The access token has expired.
    TokenExpired,

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

impl FeishuError {
    /// Returns `true` if retrying the operation might succeed.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            FeishuError::RateLimited { .. }
                | FeishuError::Timeout { .. }
                | FeishuError::ConnectionFailed(_)
                | FeishuError::TokenExpired
        )
    }

    /// Returns an optional suggested retry delay (in seconds).
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            FeishuError::RateLimited { retry_after_secs } => Some(*retry_after_secs),
            FeishuError::Timeout { timeout_ms } => Some(*timeout_ms / 2000),
            FeishuError::TokenExpired => Some(1),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for FeishuError {
    fn from(err: serde_json::Error) -> Self {
        FeishuError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for FeishuError {
    fn from(err: std::io::Error) -> Self {
        FeishuError::Internal(format!("I/O error: {}", err))
    }
}

impl From<reqwest::Error> for FeishuError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            FeishuError::Timeout { timeout_ms: 30000 }
        } else if err.is_connect() {
            FeishuError::ConnectionFailed(err.to_string())
        } else {
            FeishuError::ApiError(err.to_string())
        }
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
        let err = FeishuError::MissingSetting("FEISHU_APP_ID".to_string());
        assert!(err.to_string().contains("FEISHU_APP_ID"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(FeishuError::RateLimited {
            retry_after_secs: 10
        }
        .is_retryable());
        assert!(FeishuError::Timeout { timeout_ms: 5000 }.is_retryable());
        assert!(FeishuError::TokenExpired.is_retryable());
        assert!(!FeishuError::ClientNotInitialized.is_retryable());
    }

    #[test]
    fn test_retry_after() {
        let err = FeishuError::RateLimited {
            retry_after_secs: 10,
        };
        assert_eq!(err.retry_after_secs(), Some(10));

        let err = FeishuError::ClientNotInitialized;
        assert_eq!(err.retry_after_secs(), None);
    }
}
