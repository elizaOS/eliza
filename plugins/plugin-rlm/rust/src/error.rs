//! Error types for the RLM plugin.

use thiserror::Error;

/// Errors that can occur in the RLM plugin.
#[derive(Error, Debug, Clone)]
pub enum RLMError {
    /// Server not running or failed to start.
    #[error("RLM server not running")]
    ServerNotRunning,

    /// Request timeout.
    #[error("RLM request timeout: {0}")]
    Timeout(String),

    /// IPC communication error.
    #[error("IPC error: {0}")]
    IpcError(String),

    /// JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    JsonError(String),

    /// IO error.
    #[error("IO error: {0}")]
    IoError(String),

    /// Configuration error.
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Server returned an error.
    #[error("Server error: {0}")]
    ServerError(String),
}

impl From<serde_json::Error> for RLMError {
    fn from(e: serde_json::Error) -> Self {
        RLMError::JsonError(e.to_string())
    }
}

impl From<std::io::Error> for RLMError {
    fn from(e: std::io::Error) -> Self {
        RLMError::IoError(e.to_string())
    }
}

/// Result type alias for RLM operations.
pub type Result<T> = std::result::Result<T, RLMError>;
