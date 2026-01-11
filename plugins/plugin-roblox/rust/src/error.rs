//! Error types for the Roblox plugin.

use thiserror::Error;

/// Result type alias for Roblox operations.
pub type Result<T> = std::result::Result<T, RobloxError>;

/// Errors that can occur during Roblox operations.
#[derive(Error, Debug)]
pub enum RobloxError {
    /// Configuration error
    #[error("Configuration error: {0}")]
    Config(String),

    /// API request error
    #[error("API error: {message} (status: {status_code}, endpoint: {endpoint})")]
    Api {
        /// Error message
        message: String,
        /// HTTP status code
        status_code: u16,
        /// API endpoint
        endpoint: String,
    },

    /// Network error
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    /// JSON serialization/deserialization error
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Invalid input error
    #[error("Validation error: {0}")]
    Validation(String),

    /// Rate limit exceeded
    #[error("Rate limit exceeded: {0}")]
    RateLimit(String),

    /// Resource not found
    #[error("Not found: {0}")]
    NotFound(String),

    /// Authentication error
    #[error("Authentication error: {0}")]
    Auth(String),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

impl RobloxError {
    /// Create a new configuration error.
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    /// Create a new API error.
    pub fn api(message: impl Into<String>, status_code: u16, endpoint: impl Into<String>) -> Self {
        Self::Api {
            message: message.into(),
            status_code,
            endpoint: endpoint.into(),
        }
    }

    /// Create a new validation error.
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    /// Create a new not found error.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    /// Create a new authentication error.
    pub fn auth(message: impl Into<String>) -> Self {
        Self::Auth(message.into())
    }

    /// Create a new internal error.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    /// Check if this is a rate limit error.
    pub fn is_rate_limit(&self) -> bool {
        matches!(self, Self::RateLimit(_))
    }

    /// Check if this is a not found error.
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::NotFound(_))
    }

    /// Check if this is an authentication error.
    pub fn is_auth(&self) -> bool {
        matches!(self, Self::Auth(_))
    }
}


