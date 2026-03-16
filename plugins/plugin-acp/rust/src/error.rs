//! Error types for ACP operations

use crate::types::AcpErrorResponse;
use thiserror::Error;

/// Result type alias for ACP operations
pub type Result<T> = std::result::Result<T, AcpError>;

/// ACP error types
#[derive(Error, Debug)]
pub enum AcpError {
    /// Missing required configuration
    #[error("Missing configuration: {0}")]
    MissingConfig(String),

    /// API error from merchant
    #[error("API error ({status}): {message}")]
    ApiError {
        /// HTTP status code
        status: u16,
        /// Error message
        message: String,
        /// Original error response
        response: Option<AcpErrorResponse>,
    },

    /// Network/transport error
    #[error("Network error: {0}")]
    NetworkError(String),

    /// Request timeout
    #[error("Request timeout")]
    Timeout,

    /// Serialization/deserialization error
    #[error("Serialization error: {0}")]
    SerializationError(String),

    /// Invalid request
    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    /// Session not found
    #[error("Checkout session not found: {0}")]
    SessionNotFound(String),

    /// Session already completed
    #[error("Checkout session already completed: {0}")]
    SessionAlreadyCompleted(String),

    /// Session already canceled
    #[error("Checkout session already canceled: {0}")]
    SessionAlreadyCanceled(String),

    /// Payment error
    #[error("Payment error: {0}")]
    PaymentError(String),

    /// Validation error
    #[error("Validation error: {0}")]
    ValidationError(String),

    /// Internal error
    #[error("Internal error: {0}")]
    InternalError(String),
}

impl AcpError {
    /// Create an API error from status code and message
    pub fn api_error(status: u16, message: impl Into<String>) -> Self {
        Self::ApiError {
            status,
            message: message.into(),
            response: None,
        }
    }

    /// Create an API error from an AcpErrorResponse
    pub fn from_response(status: u16, response: AcpErrorResponse) -> Self {
        Self::ApiError {
            status,
            message: response.message.clone(),
            response: Some(response),
        }
    }

    /// Check if error is retryable
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::NetworkError(_) | Self::Timeout => true,
            Self::ApiError { status, .. } => {
                // 429 (rate limit) and 5xx errors are retryable
                *status == 429 || *status >= 500
            }
            _ => false,
        }
    }

    /// Get HTTP status code if available
    pub fn status_code(&self) -> Option<u16> {
        match self {
            Self::ApiError { status, .. } => Some(*status),
            Self::SessionNotFound(_) => Some(404),
            Self::InvalidRequest(_) | Self::ValidationError(_) => Some(400),
            _ => None,
        }
    }
}

#[cfg(feature = "native")]
impl From<reqwest::Error> for AcpError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            Self::Timeout
        } else if err.is_connect() || err.is_request() {
            Self::NetworkError(err.to_string())
        } else {
            Self::InternalError(err.to_string())
        }
    }
}

impl From<serde_json::Error> for AcpError {
    fn from(err: serde_json::Error) -> Self {
        Self::SerializationError(err.to_string())
    }
}
