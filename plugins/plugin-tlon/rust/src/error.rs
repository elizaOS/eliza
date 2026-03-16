//! Error types for the Tlon plugin.

use thiserror::Error;

/// Result type alias using [`TlonError`].
pub type Result<T> = std::result::Result<T, TlonError>;

/// Errors that can occur when using the Tlon plugin.
#[derive(Debug, Error)]
pub enum TlonError {
    /// A required configuration value is missing.
    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    /// Configuration validation failed.
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Authentication with the Urbit ship failed.
    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    /// Failed to connect to the Urbit ship.
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// The client is not initialized.
    #[error("Client not initialized")]
    ClientNotInitialized,

    /// The service is already running.
    #[error("Service is already running")]
    AlreadyRunning,

    /// An API request failed.
    #[error("API error: {0}")]
    ApiError(String),

    /// A poke operation failed.
    #[error("Poke failed: {0}")]
    PokeFailed(String),

    /// A scry operation failed.
    #[error("Scry failed: {0}")]
    ScryFailed(String),

    /// A subscription operation failed.
    #[error("Subscribe failed: {0}")]
    SubscribeFailed(String),

    /// SSE stream error.
    #[error("SSE stream error: {0}")]
    StreamError(String),

    /// An invalid argument was provided.
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// Channel not found.
    #[error("Channel not found: {0}")]
    ChannelNotFound(String),

    /// Ship not found.
    #[error("Ship not found: {0}")]
    ShipNotFound(String),

    /// Message send failed.
    #[error("Failed to send message: {0}")]
    SendFailed(String),

    /// Serialization/deserialization error.
    #[error("Serialization error: {0}")]
    SerializationError(String),

    /// HTTP request error.
    #[error("HTTP error: {0}")]
    HttpError(String),

    /// Generic error wrapper.
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for TlonError {
    fn from(err: reqwest::Error) -> Self {
        TlonError::HttpError(err.to_string())
    }
}

impl From<serde_json::Error> for TlonError {
    fn from(err: serde_json::Error) -> Self {
        TlonError::SerializationError(err.to_string())
    }
}

impl From<url::ParseError> for TlonError {
    fn from(err: url::ParseError) -> Self {
        TlonError::InvalidArgument(format!("Invalid URL: {}", err))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = TlonError::MissingSetting("TLON_SHIP".to_string());
        assert!(err.to_string().contains("TLON_SHIP"));
    }

    #[test]
    fn test_error_from_reqwest() {
        // We can't easily create a reqwest::Error for testing,
        // but we can verify the error type exists
        let err: TlonError = TlonError::HttpError("test error".to_string());
        assert!(err.to_string().contains("HTTP error"));
    }
}
