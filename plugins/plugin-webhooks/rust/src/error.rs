//! Custom error types for the webhooks plugin.

use thiserror::Error;

/// Top-level error type for webhook operations.
#[derive(Debug, Error)]
pub enum WebhookError {
    /// Webhook authentication failed.
    #[error("Unauthorized")]
    Authentication,

    /// Request validation failed (missing fields, etc.).
    #[error("Bad request: {0}")]
    Validation(String),

    /// A resource (hook mapping, config, etc.) was not found.
    #[error("Not found: {0}")]
    NotFound(String),

    /// An agent turn exceeded its timeout.
    #[error("Agent turn timeout")]
    Timeout,

    /// A generic internal error.
    #[error("{0}")]
    Internal(String),
}

impl WebhookError {
    /// Map the error variant to an HTTP status code.
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Authentication => 401,
            Self::Validation(_) => 400,
            Self::NotFound(_) => 404,
            Self::Timeout => 504,
            Self::Internal(_) => 500,
        }
    }
}
