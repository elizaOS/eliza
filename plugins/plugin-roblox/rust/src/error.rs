#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, RobloxError>;

#[derive(Error, Debug)]
pub enum RobloxError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("API error: {message} (status: {status_code}, endpoint: {endpoint})")]
    Api {
        message: String,
        status_code: u16,
        endpoint: String,
    },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Rate limit exceeded: {0}")]
    RateLimit(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl RobloxError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    pub fn api(message: impl Into<String>, status_code: u16, endpoint: impl Into<String>) -> Self {
        Self::Api {
            message: message.into(),
            status_code,
            endpoint: endpoint.into(),
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::Auth(message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn is_rate_limit(&self) -> bool {
        matches!(self, Self::RateLimit(_))
    }

    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::NotFound(_))
    }

    pub fn is_auth(&self) -> bool {
        matches!(self, Self::Auth(_))
    }
}
