//! Error types for the Google GenAI client.
//!
//! All errors are strongly typed with no generic error handling.
//! Errors are designed to provide actionable information.

use thiserror::Error;

/// Result type for Google GenAI operations.
pub type Result<T> = std::result::Result<T, GoogleGenAIError>;

/// Errors that can occur when using the Google GenAI client.
#[derive(Error, Debug)]
pub enum GoogleGenAIError {
    /// API key is missing or invalid.
    #[error("API key error: {message}")]
    ApiKeyError {
        /// Details about the API key error.
        message: String,
    },

    /// Configuration error.
    #[error("Configuration error: {message}")]
    ConfigError {
        /// Details about what's misconfigured.
        message: String,
    },

    /// HTTP request failed.
    #[error("HTTP request failed: {message}")]
    HttpError {
        /// Details about the HTTP error.
        message: String,
        /// HTTP status code, if available.
        status_code: Option<u16>,
    },

    /// Rate limit exceeded.
    #[error("Rate limit exceeded: retry after {retry_after_seconds} seconds")]
    RateLimitError {
        /// Seconds to wait before retrying.
        retry_after_seconds: u64,
    },

    /// API returned an error response.
    #[error("API error ({error_type}): {message}")]
    ApiError {
        /// Type of error from the API.
        error_type: String,
        /// Error message from the API.
        message: String,
    },

    /// Failed to parse API response.
    #[error("Response parsing error: {message}")]
    ParseError {
        /// Details about what failed to parse.
        message: String,
    },

    /// JSON generation failed.
    #[error("JSON generation error: {message}")]
    JsonGenerationError {
        /// Details about the JSON generation failure.
        message: String,
    },

    /// Invalid parameter provided.
    #[error("Invalid parameter '{parameter}': {message}")]
    InvalidParameter {
        /// Name of the invalid parameter.
        parameter: String,
        /// Why it's invalid.
        message: String,
    },

    /// Model not supported.
    #[error("Model not supported: {model}")]
    UnsupportedModel {
        /// The unsupported model name.
        model: String,
    },

    /// Network error.
    #[error("Network error: {message}")]
    NetworkError {
        /// Details about the network error.
        message: String,
    },

    /// Request timeout.
    #[error("Request timed out after {timeout_seconds} seconds")]
    Timeout {
        /// Timeout duration in seconds.
        timeout_seconds: u64,
    },

    /// Server error (5xx).
    #[error("Server error ({status_code}): {message}")]
    ServerError {
        /// HTTP status code.
        status_code: u16,
        /// Error message.
        message: String,
    },
}

impl GoogleGenAIError {
    /// Create an API key error.
    pub fn api_key<S: Into<String>>(message: S) -> Self {
        Self::ApiKeyError {
            message: message.into(),
        }
    }

    /// Create a configuration error.
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError {
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

    /// Create a parse error.
    pub fn parse<S: Into<String>>(message: S) -> Self {
        Self::ParseError {
            message: message.into(),
        }
    }

    /// Create a JSON generation error.
    pub fn json_generation<S: Into<String>>(message: S) -> Self {
        Self::JsonGenerationError {
            message: message.into(),
        }
    }

    /// Create an invalid parameter error.
    pub fn invalid_parameter<S: Into<String>>(parameter: S, message: S) -> Self {
        Self::InvalidParameter {
            parameter: parameter.into(),
            message: message.into(),
        }
    }

    /// Check if this error is retryable.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimitError { .. }
                | Self::NetworkError { .. }
                | Self::Timeout { .. }
                | Self::ServerError { .. }
        )
    }

    /// Get retry delay in seconds if this is a rate limit error.
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


