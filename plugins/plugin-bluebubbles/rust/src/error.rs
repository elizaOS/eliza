//! Error types for the BlueBubbles plugin

use thiserror::Error;

/// Result type for BlueBubbles operations
pub type Result<T> = std::result::Result<T, BlueBubblesError>;

/// Errors that can occur in the BlueBubbles plugin
#[derive(Error, Debug)]
pub enum BlueBubblesError {
    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Connection error
    #[error("Connection error: {0}")]
    ConnectionError(String),

    /// API error
    #[error("API error ({status}): {message}")]
    ApiError { status: u16, message: String },

    /// Authentication error
    #[error("Authentication error: {0}")]
    AuthError(String),

    /// Message sending error
    #[error("Failed to send message: {0}")]
    SendError(String),

    /// Chat not found
    #[error("Chat not found: {0}")]
    ChatNotFound(String),

    /// Target resolution error
    #[error("Failed to resolve target: {0}")]
    TargetResolutionError(String),

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// Timeout error
    #[error("Request timed out")]
    Timeout,

    /// Serialization error
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    /// HTTP client error
    #[error("HTTP error: {0}")]
    HttpError(#[from] reqwest::Error),

    /// URL parsing error
    #[error("Invalid URL: {0}")]
    UrlError(#[from] url::ParseError),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

impl BlueBubblesError {
    /// Creates a new configuration error
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError(message.into())
    }

    /// Creates a new connection error
    pub fn connection<S: Into<String>>(message: S) -> Self {
        Self::ConnectionError(message.into())
    }

    /// Creates a new API error
    pub fn api(status: u16, message: impl Into<String>) -> Self {
        Self::ApiError {
            status,
            message: message.into(),
        }
    }

    /// Creates a new authentication error
    pub fn auth<S: Into<String>>(message: S) -> Self {
        Self::AuthError(message.into())
    }

    /// Creates a new send error
    pub fn send<S: Into<String>>(message: S) -> Self {
        Self::SendError(message.into())
    }

    /// Creates a new chat not found error
    pub fn chat_not_found<S: Into<String>>(chat_id: S) -> Self {
        Self::ChatNotFound(chat_id.into())
    }

    /// Creates a new target resolution error
    pub fn target_resolution<S: Into<String>>(message: S) -> Self {
        Self::TargetResolutionError(message.into())
    }

    /// Creates a new permission denied error
    pub fn permission_denied<S: Into<String>>(message: S) -> Self {
        Self::PermissionDenied(message.into())
    }

    /// Creates a new internal error
    pub fn internal<S: Into<String>>(message: S) -> Self {
        Self::Internal(message.into())
    }
}
