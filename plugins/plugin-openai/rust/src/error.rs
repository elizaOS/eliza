#![allow(missing_docs)]
//! Error types for OpenAI plugin.

use thiserror::Error;

/// OpenAI client errors.
#[derive(Error, Debug)]
pub enum OpenAIError {
    /// HTTP request failed.
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    /// JSON serialization/deserialization failed.
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    /// API returned an error response.
    #[error("OpenAI API error ({status}): {message}")]
    ApiError {
        /// HTTP status code.
        status: u16,
        /// Error message from API.
        message: String,
    },

    /// Invalid configuration.
    #[error("Invalid configuration: {0}")]
    ConfigError(String),

    /// Empty response from API.
    #[error("API returned empty response")]
    EmptyResponse,

    /// URL parsing error.
    #[error("URL parsing error: {0}")]
    UrlError(#[from] url::ParseError),

    /// Tokenization error.
    #[error("Tokenization error: {0}")]
    TokenizerError(String),

    /// Response parsing error.
    #[error("Failed to parse response: {0}")]
    ParseError(String),
}

/// Result type alias for OpenAI operations.
pub type Result<T> = std::result::Result<T, OpenAIError>;

