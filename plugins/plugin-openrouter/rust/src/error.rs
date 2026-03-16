#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, OpenRouterError>;

#[derive(Error, Debug)]
pub enum OpenRouterError {
    #[error("API key error: {message}")]
    ApiKeyError { message: String },

    #[error("Configuration error: {message}")]
    ConfigError { message: String },

    #[error("HTTP error: {message}")]
    HttpError {
        message: String,
        status_code: Option<u16>,
    },

    #[error("Rate limit exceeded. Retry after {retry_after_seconds} seconds")]
    RateLimitError { retry_after_seconds: u64 },

    #[error("JSON error: {message}")]
    JsonError { message: String },

    #[error("Network error: {0}")]
    NetworkError(#[from] reqwest::Error),
}

impl OpenRouterError {
    pub fn api_key<S: Into<String>>(message: S) -> Self {
        Self::ApiKeyError {
            message: message.into(),
        }
    }

    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError {
            message: message.into(),
        }
    }

    pub fn http<S: Into<String>>(message: S, status_code: Option<u16>) -> Self {
        Self::HttpError {
            message: message.into(),
            status_code,
        }
    }

    pub fn rate_limit(retry_after_seconds: u64) -> Self {
        Self::RateLimitError {
            retry_after_seconds,
        }
    }

    pub fn json<S: Into<String>>(message: S) -> Self {
        Self::JsonError {
            message: message.into(),
        }
    }
}
