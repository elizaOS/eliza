//! Error types for the OpenRouter client.
//!
//! All errors are strongly typed and provide useful context.

use thiserror::Error;

/// Result type for OpenRouter operations.
pub type Result<T> = std::result::Result<T, OpenRouterError>;

/// Errors that can occur when using the OpenRouter client.
#[derive(Error, Debug)]
pub enum OpenRouterError {
    /// API key error.
    #[error("API key error: {message}")]
    ApiKeyError {
        /// Error message.
        message: String,
    },

    /// Configuration error.
    #[error("Configuration error: {message}")]
    ConfigError {
        /// Error message.
        message: String,
    },

    /// HTTP request failed.
    #[error("HTTP error: {message}")]
    HttpError {
        /// Error message.
        message: String,
        /// Optional status code.
        status_code: Option<u16>,
    },

    /// Rate limit exceeded.
    #[error("Rate limit exceeded. Retry after {retry_after_seconds} seconds")]
    RateLimitError {
        /// Seconds to wait before retrying.
        retry_after_seconds: u64,
    },

    /// JSON parsing error.
    #[error("JSON error: {message}")]
    JsonError {
        /// Error message.
        message: String,
    },

    /// Network error from reqwest.
    #[error("Network error: {0}")]
    NetworkError(#[from] reqwest::Error),
}

impl OpenRouterError {
    /// Create an API key error.
    pub fn api_key<S: Into<String>>(message: S) -> Self {
        Self::ApiKeyError {
            message: message.into(),
        }
    }

    /// Create a configuration error.
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError {
            message: message.into(),
        }
    }

    /// Create an HTTP error.
    pub fn http<S: Into<String>>(message: S, status_code: Option<u16>) -> Self {
        Self::HttpError {
            message: message.into(),
            status_code,
        }
    }

    /// Create a rate limit error.
    pub fn rate_limit(retry_after_seconds: u64) -> Self {
        Self::RateLimitError {
            retry_after_seconds,
        }
    }

    /// Create a JSON error.
    pub fn json<S: Into<String>>(message: S) -> Self {
        Self::JsonError {
            message: message.into(),
        }
    }
}


