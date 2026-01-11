//! Error types for the Ollama client.
//!
//! All errors are strongly typed and provide useful context.

use thiserror::Error;

/// Result type for Ollama operations.
pub type Result<T> = std::result::Result<T, OllamaError>;

/// Errors that can occur when using the Ollama client.
#[derive(Error, Debug)]
pub enum OllamaError {
    /// Configuration error.
    #[error("Configuration error: {message}")]
    ConfigError {
        /// Error message.
        message: String,
    },

    /// Failed to connect to Ollama server.
    #[error("Connection error: Failed to connect to {url}: {message}")]
    ConnectionError {
        /// The URL that failed.
        url: String,
        /// Error message.
        message: String,
    },

    /// HTTP request failed.
    #[error("HTTP error: {message}")]
    HttpError {
        /// Error message.
        message: String,
        /// Optional status code.
        status_code: Option<u16>,
    },

    /// Model not found.
    #[error("Model not found: {model}. Try: ollama pull {model}")]
    ModelNotFoundError {
        /// The model that was not found.
        model: String,
    },

    /// JSON parsing error.
    #[error("JSON error: {message}")]
    JsonError {
        /// Error message.
        message: String,
    },

    /// Network error from reqwest.
    #[error("Network error: {0}")]
    NetworkError(#[from] reqwest::Error),
}

impl OllamaError {
    /// Create a configuration error.
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError {
            message: message.into(),
        }
    }

    /// Create a connection error.
    pub fn connection<S: Into<String>>(url: S, message: S) -> Self {
        Self::ConnectionError {
            url: url.into(),
            message: message.into(),
        }
    }

    /// Create an HTTP error.
    pub fn http<S: Into<String>>(message: S, status_code: Option<u16>) -> Self {
        Self::HttpError {
            message: message.into(),
            status_code,
        }
    }

    /// Create a model not found error.
    pub fn model_not_found<S: Into<String>>(model: S) -> Self {
        Self::ModelNotFoundError {
            model: model.into(),
        }
    }

    /// Create a JSON error.
    pub fn json<S: Into<String>>(message: S) -> Self {
        Self::JsonError {
            message: message.into(),
        }
    }
}


