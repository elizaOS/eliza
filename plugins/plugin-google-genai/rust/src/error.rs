#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, GoogleGenAIError>;

#[derive(Error, Debug)]
pub enum GoogleGenAIError {
    #[error("API key error: {message}")]
    ApiKeyError { message: String },

    #[error("Configuration error: {message}")]
    ConfigError { message: String },

    #[error("HTTP request failed: {message}")]
    HttpError {
        message: String,
        status_code: Option<u16>,
    },

    #[error("Rate limit exceeded: retry after {retry_after_seconds} seconds")]
    RateLimitError { retry_after_seconds: u64 },

    #[error("API error ({error_type}): {message}")]
    ApiError { error_type: String, message: String },

    #[error("Response parsing error: {message}")]
    ParseError { message: String },

    #[error("JSON generation error: {message}")]
    JsonGenerationError { message: String },

    #[error("Invalid parameter '{parameter}': {message}")]
    InvalidParameter { parameter: String, message: String },

    #[error("Model not supported: {model}")]
    UnsupportedModel { model: String },

    #[error("Network error: {message}")]
    NetworkError { message: String },

    #[error("Request timed out after {timeout_seconds} seconds")]
    Timeout { timeout_seconds: u64 },

    #[error("Server error ({status_code}): {message}")]
    ServerError { status_code: u16, message: String },
}

impl GoogleGenAIError {
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

    pub fn parse<S: Into<String>>(message: S) -> Self {
        Self::ParseError {
            message: message.into(),
        }
    }

    pub fn json_generation<S: Into<String>>(message: S) -> Self {
        Self::JsonGenerationError {
            message: message.into(),
        }
    }

    pub fn invalid_parameter<S: Into<String>>(parameter: S, message: S) -> Self {
        Self::InvalidParameter {
            parameter: parameter.into(),
            message: message.into(),
        }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimitError { .. }
                | Self::NetworkError { .. }
                | Self::Timeout { .. }
                | Self::ServerError { .. }
        )
    }

    pub fn retry_after(&self) -> Option<u64> {
        match self {
            Self::RateLimitError {
                retry_after_seconds,
            } => Some(*retry_after_seconds),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for GoogleGenAIError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            Self::Timeout {
                timeout_seconds: 30,
            }
        } else if err.is_connect() {
            Self::NetworkError {
                message: format!("Connection failed: {}", err),
            }
        } else if let Some(status) = err.status() {
            let code = status.as_u16();
            if code == 429 {
                Self::RateLimitError {
                    retry_after_seconds: 60,
                }
            } else if code >= 500 {
                Self::ServerError {
                    status_code: code,
                    message: err.to_string(),
                }
            } else {
                Self::HttpError {
                    message: err.to_string(),
                    status_code: Some(code),
                }
            }
        } else {
            Self::NetworkError {
                message: err.to_string(),
            }
        }
    }
}

impl From<serde_json::Error> for GoogleGenAIError {
    fn from(err: serde_json::Error) -> Self {
        Self::ParseError {
            message: err.to_string(),
        }
    }
}
