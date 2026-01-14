#![allow(missing_docs)]

use thiserror::Error;

#[derive(Error, Debug)]
pub enum S3StorageError {
    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("AWS error: {message}")]
    AwsError { message: String },

    #[error("File error: {0}")]
    FileError(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Empty response from S3")]
    EmptyResponse,

    #[error("URL generation error: {0}")]
    UrlError(String),
}

pub type Result<T> = std::result::Result<T, S3StorageError>;
