#![allow(missing_docs)]

use thiserror::Error;

#[derive(Error, Debug)]
pub enum GatewayError {
    #[error("HTTP error: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("API error ({status}): {message}")]
    ApiError { status: u16, message: String },

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("Parse error: {0}")]
    ParseError(String),

    #[error("Empty response from API")]
    EmptyResponse,

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, GatewayError>;
