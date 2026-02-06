//! Error types for the Zalo plugin.

use thiserror::Error;

/// Result type alias for Zalo operations.
pub type Result<T> = std::result::Result<T, ZaloError>;

/// Errors that can occur when using the Zalo plugin.
#[derive(Debug, Error)]
pub enum ZaloError {
    /// Configuration error.
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Missing required setting.
    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    /// API error from Zalo.
    #[error("Zalo API error: {0}")]
    ApiError(String),

    /// Connection failed.
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Client not initialized.
    #[error("Zalo client not initialized")]
    ClientNotInitialized,

    /// Service already running.
    #[error("Zalo service is already running")]
    AlreadyRunning,

    /// Invalid argument.
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// User not found.
    #[error("User not found: {0}")]
    UserNotFound(String),

    /// Message send failed.
    #[error("Failed to send message: {0}")]
    MessageSendFailed(String),

    /// Token refresh failed.
    #[error("Token refresh failed: {0}")]
    TokenRefreshFailed(String),

    /// HTTP request error.
    #[error("HTTP error: {0}")]
    HttpError(#[from] reqwest::Error),

    /// JSON parsing error.
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
}
