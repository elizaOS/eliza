use std::fmt;
use thiserror::Error;

/// Result type used throughout the Nextcloud Talk plugin.
pub type Result<T> = std::result::Result<T, NextcloudTalkError>;

#[derive(Debug, Error)]
/// Errors produced by the Nextcloud Talk plugin.
pub enum NextcloudTalkError {
    #[error("Nextcloud Talk service not initialized - call start() first")]
    /// The Nextcloud Talk service has not been started yet.
    ServiceNotInitialized,

    #[error("Nextcloud Talk service is already running")]
    /// The Nextcloud Talk service is already running.
    AlreadyRunning,

    #[error("Failed to connect to Nextcloud Talk: {0}")]
    /// A connection attempt to Nextcloud Talk failed.
    ConnectionFailed(String),

    #[error("Nextcloud Talk API error: {0}")]
    /// A Nextcloud Talk API call failed.
    ApiError(String),

    #[error("Configuration error: {0}")]
    /// Configuration values were invalid or inconsistent.
    ConfigError(String),

    #[error("Missing required setting: {0}")]
    /// A required configuration setting was missing.
    MissingSetting(String),

    #[error("Invalid room token: {0}")]
    /// A provided room token was invalid.
    InvalidRoomToken(String),

    #[error("Invalid argument: {0}")]
    /// A caller provided an invalid argument.
    InvalidArgument(String),

    #[error("Message too long: {length} characters (max: {max})")]
    /// A message exceeded Nextcloud Talk's maximum allowed length.
    MessageTooLong {
        /// The message length that was attempted.
        length: usize,
        /// The maximum supported length.
        max: usize,
    },

    #[error("Room not found: {0}")]
    /// The requested room could not be found.
    RoomNotFound(String),

    #[error("User not found: {0}")]
    /// The requested user could not be found.
    UserNotFound(String),

    #[error("Permission denied: {0}")]
    /// The operation is not permitted.
    PermissionDenied(String),

    #[error("Authentication failed: {0}")]
    /// Authentication with Nextcloud Talk failed.
    AuthenticationFailed(String),

    #[error("Signature verification failed")]
    /// HMAC signature verification failed.
    SignatureVerificationFailed,

    #[error("Rate limited by Nextcloud Talk API, retry after {retry_after_secs}s")]
    /// Nextcloud Talk API rate limit was hit.
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

    #[error("Internal error: {0}")]
    /// An internal error occurred.
    Internal(String),

    #[error("Serialization error: {0}")]
    /// Serialization/deserialization failed.
    SerializationError(String),

    #[error("Action validation failed: {0}")]
    /// An action failed validation.
    ValidationFailed(String),

    #[error("Webhook error: {0}")]
    /// An error occurred in the webhook server.
    WebhookError(String),
}

impl NextcloudTalkError {
    /// Returns `true` if retrying the operation might succeed.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            NextcloudTalkError::RateLimited { .. }
                | NextcloudTalkError::Timeout { .. }
                | NextcloudTalkError::ConnectionFailed(_)
        )
    }

    /// Returns an optional suggested retry delay (in seconds).
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            NextcloudTalkError::RateLimited { retry_after_secs } => Some(*retry_after_secs),
            NextcloudTalkError::Timeout { timeout_ms } => Some(*timeout_ms / 2000),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for NextcloudTalkError {
    fn from(err: serde_json::Error) -> Self {
        NextcloudTalkError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for NextcloudTalkError {
    fn from(err: std::io::Error) -> Self {
        NextcloudTalkError::Internal(format!("I/O error: {}", err))
    }
}

impl From<reqwest::Error> for NextcloudTalkError {
    fn from(err: reqwest::Error) -> Self {
        NextcloudTalkError::ApiError(err.to_string())
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
        let err = NextcloudTalkError::MissingSetting("NEXTCLOUD_URL".to_string());
        assert!(err.to_string().contains("NEXTCLOUD_URL"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(NextcloudTalkError::RateLimited {
            retry_after_secs: 10
        }
        .is_retryable());
        assert!(NextcloudTalkError::Timeout { timeout_ms: 5000 }.is_retryable());
        assert!(!NextcloudTalkError::ServiceNotInitialized.is_retryable());
    }

    #[test]
    fn test_retry_after() {
        let err = NextcloudTalkError::RateLimited {
            retry_after_secs: 10,
        };
        assert_eq!(err.retry_after_secs(), Some(10));

        let err = NextcloudTalkError::ServiceNotInitialized;
        assert_eq!(err.retry_after_secs(), None);
    }
}
