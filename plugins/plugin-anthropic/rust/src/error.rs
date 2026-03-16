use thiserror::Error;

/// A specialized Result type for Anthropic API operations.
pub type Result<T> = std::result::Result<T, AnthropicError>;

/// Errors that can occur when interacting with the Anthropic API.
#[derive(Error, Debug)]
pub enum AnthropicError {
    /// Error related to API key validation or authentication.
    #[error("API key error: {message}")]
    ApiKeyError {
        /// Detailed error message.
        message: String,
    },

    /// Error in client configuration.
    #[error("Configuration error: {message}")]
    ConfigError {
        /// Detailed error message.
        message: String,
    },

    /// HTTP request failed.
    #[error("HTTP request failed: {message}")]
    HttpError {
        /// Detailed error message.
        message: String,
        /// HTTP status code, if available.
        status_code: Option<u16>,
    },

    /// Rate limit exceeded; should retry after the specified duration.
    #[error("Rate limit exceeded: retry after {retry_after_seconds} seconds")]
    RateLimitError {
        /// Number of seconds to wait before retrying.
        retry_after_seconds: u64,
    },

    /// Error returned by the Anthropic API.
    #[error("API error ({error_type}): {message}")]
    ApiError {
        /// The type of error as reported by the API.
        error_type: String,
        /// Detailed error message from the API.
        message: String,
    },

    /// Failed to parse the API response.
    #[error("Response parsing error: {message}")]
    ParseError {
        /// Detailed error message.
        message: String,
    },

    /// Failed to extract valid JSON from model output.
    #[error("JSON generation error: {message}")]
    JsonGenerationError {
        /// Detailed error message.
        message: String,
    },

    /// An invalid parameter was provided.
    #[error("Invalid parameter '{parameter}': {message}")]
    InvalidParameter {
        /// The name of the invalid parameter.
        parameter: String,
        /// Explanation of why the parameter is invalid.
        message: String,
    },

    /// The requested model is not supported.
    #[error("Model not supported: {model}")]
    UnsupportedModel {
        /// The unsupported model identifier.
        model: String,
    },

    /// Network connectivity error.
    #[error("Network error: {message}")]
    NetworkError {
        /// Detailed error message.
        message: String,
    },

    /// Request timed out.
    #[error("Request timed out after {timeout_seconds} seconds")]
    Timeout {
        /// The timeout duration in seconds.
        timeout_seconds: u64,
    },

    /// Server returned an error status code.
    #[error("Server error ({status_code}): {message}")]
    ServerError {
        /// HTTP status code.
        status_code: u16,
        /// Detailed error message.
        message: String,
    },
}

impl AnthropicError {
    /// Creates an API key error with the given message.
    pub fn api_key<S: Into<String>>(message: S) -> Self {
        Self::ApiKeyError {
            message: message.into(),
        }
    }

    /// Creates a configuration error with the given message.
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError {
            message: message.into(),
        }
    }

    /// Creates an HTTP error with the given message and optional status code.
    pub fn http<S: Into<String>>(message: S, status_code: Option<u16>) -> Self {
        Self::HttpError {
            message: message.into(),
            status_code,
        }
    }

    /// Creates a parse error with the given message.
    pub fn parse<S: Into<String>>(message: S) -> Self {
        Self::ParseError {
            message: message.into(),
        }
    }

    /// Creates a JSON generation error with the given message.
    pub fn json_generation<S: Into<String>>(message: S) -> Self {
        Self::JsonGenerationError {
            message: message.into(),
        }
    }

    /// Creates an invalid parameter error.
    pub fn invalid_parameter<S: Into<String>>(parameter: S, message: S) -> Self {
        Self::InvalidParameter {
            parameter: parameter.into(),
            message: message.into(),
        }
    }

    /// Returns true if the error is potentially transient and the request could be retried.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimitError { .. }
                | Self::NetworkError { .. }
                | Self::Timeout { .. }
                | Self::ServerError { .. }
        )
    }

    /// Returns the number of seconds to wait before retrying, if applicable.
    pub fn retry_after(&self) -> Option<u64> {
        match self {
            Self::RateLimitError {
                retry_after_seconds,
            } => Some(*retry_after_seconds),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for AnthropicError {
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

impl From<serde_json::Error> for AnthropicError {
    fn from(err: serde_json::Error) -> Self {
        Self::ParseError {
            message: err.to_string(),
        }
    }
}
