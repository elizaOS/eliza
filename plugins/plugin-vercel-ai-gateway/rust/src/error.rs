#![allow(missing_docs)]
//! Error types for the Vercel AI Gateway plugin.

use thiserror::Error;

/// Error type for Gateway operations.
#[derive(Error, Debug)]
pub enum GatewayError {
    /// HTTP request failed.
    #[error("HTTP error: {0}")]
    HttpError(#[from] reqwest::Error),

    /// API returned an error response.
    #[error("API error ({status}): {message}")]
    ApiError {
        /// HTTP status code.
        status: u16,
        /// Error message.
        message: String,
    },

    /// Configuration error.
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Response parsing failed.
    #[error("Parse error: {0}")]
    ParseError(String),

    /// API returned empty response.
    #[error("Empty response from API")]
    EmptyResponse,

    /// JSON serialization/deserialization failed.
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
}

/// Result type alias for Gateway operations.
pub type Result<T> = std::result::Result<T, GatewayError>;







