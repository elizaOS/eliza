//! Error types for the Twitter plugin.

use thiserror::Error;

/// Result type for Twitter operations.
pub type Result<T> = std::result::Result<T, TwitterError>;

/// Error types for Twitter client operations.
#[derive(Error, Debug)]
pub enum TwitterError {
    /// HTTP request error
    #[error("HTTP error: {0}")]
    HttpError(#[from] reqwest::Error),

    /// Twitter API error with status code and message
    #[error("Twitter API error ({status}): {message}")]
    ApiError {
        /// HTTP status code
        status: u16,
        /// Error message
        message: String,
    },

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Authentication error
    #[error("Authentication error: {0}")]
    AuthError(String),

    /// Parse error
    #[error("Parse error: {0}")]
    ParseError(String),

    /// Empty response from API
    #[error("Empty response from API")]
    EmptyResponse,

    /// Grok API error
    #[error("Grok API error ({status}): {message}")]
    GrokError {
        /// HTTP status code
        status: u16,
        /// Error message
        message: String,
    },
}

