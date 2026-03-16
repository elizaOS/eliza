#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, OllamaError>;

#[derive(Error, Debug)]
pub enum OllamaError {
    #[error("Configuration error: {message}")]
    ConfigError { message: String },

    #[error("Connection error: Failed to connect to {url}: {message}")]
    ConnectionError { url: String, message: String },

    #[error("HTTP error: {message}")]
    HttpError {
        message: String,
        status_code: Option<u16>,
    },

    #[error("Model not found: {model}. Try: ollama pull {model}")]
    ModelNotFoundError { model: String },

    #[error("JSON error: {message}")]
    JsonError { message: String },

    #[error("Network error: {0}")]
    NetworkError(#[from] reqwest::Error),
}

impl OllamaError {
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError {
            message: message.into(),
        }
    }

    pub fn connection<S: Into<String>>(url: S, message: S) -> Self {
        Self::ConnectionError {
            url: url.into(),
            message: message.into(),
        }
    }

    pub fn http<S: Into<String>>(message: S, status_code: Option<u16>) -> Self {
        Self::HttpError {
            message: message.into(),
            status_code,
        }
    }

    pub fn model_not_found<S: Into<String>>(model: S) -> Self {
        Self::ModelNotFoundError {
            model: model.into(),
        }
    }

    pub fn json<S: Into<String>>(message: S) -> Self {
        Self::JsonError {
            message: message.into(),
        }
    }
}
