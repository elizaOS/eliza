//! Error types for S3 Storage Plugin

use thiserror::Error;

/// S3 Storage error type.
#[derive(Error, Debug)]
pub enum S3StorageError {
    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// AWS SDK error
    #[error("AWS error: {message}")]
    AwsError {
        /// Error message
        message: String,
    },

    /// File system error
    #[error("File error: {0}")]
    FileError(#[from] std::io::Error),

    /// Serialization error
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    /// File not found
    #[error("File not found: {0}")]
    FileNotFound(String),

    /// Empty response from S3
    #[error("Empty response from S3")]
    EmptyResponse,

    /// URL generation error
    #[error("URL generation error: {0}")]
    UrlError(String),
}

/// Result type alias for S3 storage operations.
pub type Result<T> = std::result::Result<T, S3StorageError>;

