//! Error types for plugin-prose

use thiserror::Error;

/// Prose plugin errors
#[derive(Error, Debug)]
pub enum ProseError {
    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
}

/// Result type alias for Prose operations
pub type Result<T> = std::result::Result<T, ProseError>;
