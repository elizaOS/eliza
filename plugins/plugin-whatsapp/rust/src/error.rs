//! Error types for the WhatsApp plugin

use thiserror::Error;

/// Result type for WhatsApp operations
pub type Result<T> = std::result::Result<T, WhatsAppError>;

/// Errors that can occur in the WhatsApp plugin
#[derive(Error, Debug)]
pub enum WhatsAppError {
    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// API error
    #[error("WhatsApp API error ({code}): {message}")]
    ApiError { code: i32, message: String },

    /// Authentication error
    #[error("Authentication error: {0}")]
    AuthError(String),

    /// Webhook verification error
    #[error("Webhook verification failed: {0}")]
    WebhookError(String),

    /// Message sending error
    #[error("Failed to send message: {0}")]
    SendError(String),

    /// HTTP client error
    #[error("HTTP error: {0}")]
    HttpError(#[from] reqwest::Error),

    /// Serialization error
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

impl WhatsAppError {
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError(message.into())
    }

    pub fn api(code: i32, message: impl Into<String>) -> Self {
        Self::ApiError {
            code,
            message: message.into(),
        }
    }

    pub fn auth<S: Into<String>>(message: S) -> Self {
        Self::AuthError(message.into())
    }

    pub fn webhook<S: Into<String>>(message: S) -> Self {
        Self::WebhookError(message.into())
    }

    pub fn send<S: Into<String>>(message: S) -> Self {
        Self::SendError(message.into())
    }

    pub fn internal<S: Into<String>>(message: S) -> Self {
        Self::Internal(message.into())
    }
}
