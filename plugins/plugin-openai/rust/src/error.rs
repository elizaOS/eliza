#![allow(missing_docs)]

use thiserror::Error;

#[derive(Error, Debug)]
pub enum OpenAIError {
    #[error("HTTP request failed: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("OpenAI API error ({status}): {message}")]
    ApiError { status: u16, message: String },

    #[error("Invalid configuration: {0}")]
    ConfigError(String),

    #[error("API returned empty response")]
    EmptyResponse,

    #[error("URL parsing error: {0}")]
    UrlError(#[from] url::ParseError),

    #[error("Tokenization error: {0}")]
    TokenizerError(String),

    #[error("Failed to parse response: {0}")]
    ParseError(String),
}

pub type Result<T> = std::result::Result<T, OpenAIError>;
