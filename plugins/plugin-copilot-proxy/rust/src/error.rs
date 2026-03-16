//! Error types for the Copilot Proxy plugin.

use thiserror::Error;

/// Errors that can occur when using the Copilot Proxy client.
#[derive(Error, Debug)]
pub enum CopilotProxyError {
    /// HTTP request failed.
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    /// JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    /// API returned an error response.
    #[error("Copilot Proxy API error ({status}): {message}")]
    ApiError {
        /// HTTP status code.
        status: u16,
        /// Error message from the API.
        message: String,
    },

    /// Invalid configuration.
    #[error("Invalid configuration: {0}")]
    ConfigError(String),

    /// API returned an empty response.
    #[error("API returned empty response")]
    EmptyResponse,

    /// URL parsing error.
    #[error("URL parsing error: {0}")]
    UrlError(#[from] url::ParseError),

    /// Failed to extract JSON from response.
    #[error("Failed to extract JSON: {0}")]
    JsonExtractionError(String),

    /// Request timed out.
    #[error("Request timed out after {0} seconds")]
    Timeout(u64),

    /// Plugin is disabled.
    #[error("Plugin is disabled")]
    Disabled,
}

/// Result type alias for Copilot Proxy operations.
pub type Result<T> = std::result::Result<T, CopilotProxyError>;
