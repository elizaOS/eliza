#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, BlueSkyError>;

#[derive(Error, Debug)]
pub enum BlueSkyError {
    #[error("Config: {0}")]
    Config(String),

    #[error("Auth: {0}")]
    Auth(String),

    #[error("HTTP {status}: {message}")]
    Http { message: String, status: u16 },

    #[error("Rate limited, retry after {0}s")]
    RateLimit(u64),

    #[error("Post {operation}: {message}")]
    Post { message: String, operation: String },

    #[error("Message {operation}: {message}")]
    Message { message: String, operation: String },

    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Request: {0}")]
    Request(#[from] reqwest::Error),
}

impl BlueSkyError {
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }

    pub fn auth(msg: impl Into<String>) -> Self {
        Self::Auth(msg.into())
    }

    pub fn http(msg: impl Into<String>, status: u16) -> Self {
        Self::Http {
            message: msg.into(),
            status,
        }
    }

    pub fn post(msg: impl Into<String>, op: impl Into<String>) -> Self {
        Self::Post {
            message: msg.into(),
            operation: op.into(),
        }
    }

    pub fn message(msg: impl Into<String>, op: impl Into<String>) -> Self {
        Self::Message {
            message: msg.into(),
            operation: op.into(),
        }
    }
}
