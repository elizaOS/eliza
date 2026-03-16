#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, MoltbookError>;

#[derive(Error, Debug)]
pub enum MoltbookError {
    #[error("Authentication required: {0}")]
    Authentication(String),

    #[error("API error (status {status}): {message}")]
    Api { status: u16, message: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Content too long: {0}")]
    ContentTooLong(String),

    #[error("Moltbook service not available")]
    ServiceUnavailable,

    #[error("Configuration error: {0}")]
    Configuration(String),
}
