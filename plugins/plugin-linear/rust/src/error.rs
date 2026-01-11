//! Error types for the Linear plugin.

use thiserror::Error;

/// Result type alias for Linear operations
pub type Result<T> = std::result::Result<T, LinearError>;

/// Errors that can occur when interacting with the Linear API
#[derive(Error, Debug)]
pub enum LinearError {
    /// Authentication error (invalid or missing API key)
    #[error("Authentication failed: {0}")]
    Authentication(String),

    /// Rate limit exceeded
    #[error("Rate limit exceeded, retry after {reset_time} seconds")]
    RateLimit { reset_time: u64 },

    /// API error with status code
    #[error("API error (status {status}): {message}")]
    Api { status: u16, message: String },

    /// GraphQL error
    #[error("GraphQL error: {0}")]
    GraphQL(String),

    /// Network error
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    /// JSON parsing error
    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    /// Resource not found
    #[error("Resource not found: {0}")]
    NotFound(String),

    /// Invalid input
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// Service not available
    #[error("Linear service not available")]
    ServiceUnavailable,
}


