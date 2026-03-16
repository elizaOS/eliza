#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, LinearError>;

#[derive(Error, Debug)]
pub enum LinearError {
    #[error("Authentication failed: {0}")]
    Authentication(String),

    #[error("Rate limit exceeded, retry after {reset_time} seconds")]
    RateLimit { reset_time: u64 },

    #[error("API error (status {status}): {message}")]
    Api { status: u16, message: String },

    #[error("GraphQL error: {0}")]
    GraphQL(String),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Linear service not available")]
    ServiceUnavailable,
}
