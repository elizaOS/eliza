//! Error types for the Zalo User plugin.

use thiserror::Error;

/// Result type alias for Zalo User operations.
pub type Result<T> = std::result::Result<T, ZaloUserError>;

/// Errors that can occur in the Zalo User plugin.
#[derive(Error, Debug)]
pub enum ZaloUserError {
    /// zca-cli is not installed or not found in PATH.
    #[error("zca-cli not found in PATH. Install it with: npm install -g zca-cli")]
    ZcaNotInstalled,

    /// Authentication required.
    #[error("Not authenticated. Run 'zca auth login' to authenticate.")]
    NotAuthenticated,

    /// Invalid configuration.
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    /// Service is already running.
    #[error("Service is already running")]
    AlreadyRunning,

    /// Service is not running.
    #[error("Service is not running")]
    NotRunning,

    /// Client not initialized.
    #[error("Client not initialized")]
    ClientNotInitialized,

    /// Connection failed.
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Command execution failed.
    #[error("Command failed: {0}")]
    CommandFailed(String),

    /// Command timed out.
    #[error("Command timed out after {0}ms")]
    Timeout(u64),

    /// API error from Zalo.
    #[error("Zalo API error: {0}")]
    ApiError(String),

    /// Failed to send message.
    #[error("Failed to send message: {0}")]
    SendFailed(String),

    /// Chat/thread not found.
    #[error("Chat not found: {0}")]
    ChatNotFound(String),

    /// User not found.
    #[error("User not found: {0}")]
    UserNotFound(String),

    /// Invalid argument provided.
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// JSON parsing error.
    #[error("JSON parse error: {0}")]
    JsonError(#[from] serde_json::Error),

    /// IO error.
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}
