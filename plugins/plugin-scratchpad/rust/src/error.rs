#![allow(missing_docs)]
//! Error types for the Scratchpad Plugin.

use thiserror::Error;

/// Result type alias using ScratchpadError.
pub type Result<T> = std::result::Result<T, ScratchpadError>;

/// Errors that can occur in the scratchpad plugin.
#[derive(Debug, Error)]
pub enum ScratchpadError {
    /// Entry not found
    #[error("Not found: {0}")]
    NotFound(String),

    /// Validation error
    #[error("Validation error: {0}")]
    Validation(String),

    /// File size exceeded
    #[error("File size exceeded: {0}")]
    FileSize(String),

    /// Configuration error
    #[error("Configuration error: {0}")]
    Config(String),

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Serialization error
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

impl ScratchpadError {
    /// Create a not found error.
    pub fn not_found<S: Into<String>>(msg: S) -> Self {
        Self::NotFound(msg.into())
    }

    /// Create a validation error.
    pub fn validation<S: Into<String>>(msg: S) -> Self {
        Self::Validation(msg.into())
    }

    /// Create a file size error.
    pub fn file_size<S: Into<String>>(msg: S) -> Self {
        Self::FileSize(msg.into())
    }

    /// Create a configuration error.
    pub fn config<S: Into<String>>(msg: S) -> Self {
        Self::Config(msg.into())
    }

    /// Create an internal error.
    pub fn internal<S: Into<String>>(msg: S) -> Self {
        Self::Internal(msg.into())
    }
}
