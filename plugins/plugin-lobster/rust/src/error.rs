//! Error types for plugin-lobster

use thiserror::Error;

/// Lobster plugin errors
#[derive(Error, Debug)]
pub enum LobsterError {
    #[error("Lobster executable not found: {0}")]
    ExecutableNotFound(String),

    #[error("Invalid lobster path: {0}")]
    InvalidPath(String),

    #[error("Sandbox escape attempt: {0}")]
    SandboxEscape(String),

    #[error("Command execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Command timed out")]
    Timeout,

    #[error("Failed to parse output: {0}")]
    ParseError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
}

/// Result type alias for Lobster operations
pub type Result<T> = std::result::Result<T, LobsterError>;
