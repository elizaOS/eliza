#![allow(missing_docs)]

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElizaCloudErrorCode {
    InvalidApiKey,
    RateLimitExceeded,
    InvalidRequest,
    ApiError,
    NetworkError,
    InvalidResponse,
    ConfigurationError,
    Unknown,
}

impl std::fmt::Display for ElizaCloudErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidApiKey => write!(f, "INVALID_API_KEY"),
            Self::RateLimitExceeded => write!(f, "RATE_LIMIT_EXCEEDED"),
            Self::InvalidRequest => write!(f, "INVALID_REQUEST"),
            Self::ApiError => write!(f, "API_ERROR"),
            Self::NetworkError => write!(f, "NETWORK_ERROR"),
            Self::InvalidResponse => write!(f, "INVALID_RESPONSE"),
            Self::ConfigurationError => write!(f, "CONFIGURATION_ERROR"),
            Self::Unknown => write!(f, "UNKNOWN"),
        }
    }
}

#[derive(Debug, Error)]
pub enum ElizaCloudError {
    #[error("Authentication failed: {message}")]
    Authentication {
        message: String,
        code: ElizaCloudErrorCode,
    },

    #[error("Rate limit exceeded: {message}. Retry after {retry_after:?} seconds")]
    RateLimit {
        message: String,
        retry_after: Option<u32>,
    },

    #[error("Invalid request: {message}")]
    InvalidRequest {
        message: String,
        errors: Vec<String>,
    },

    #[error("API error ({status}): {message}")]
    Api {
        status: u16,
        message: String,
        body: Option<String>,
    },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl ElizaCloudError {
    pub fn code(&self) -> ElizaCloudErrorCode {
        match self {
            Self::Authentication { code, .. } => *code,
            Self::RateLimit { .. } => ElizaCloudErrorCode::RateLimitExceeded,
            Self::InvalidRequest { .. } => ElizaCloudErrorCode::InvalidRequest,
            Self::Api { .. } => ElizaCloudErrorCode::ApiError,
            Self::Network(_) => ElizaCloudErrorCode::NetworkError,
            Self::Json(_) => ElizaCloudErrorCode::InvalidResponse,
            Self::Configuration(_) => ElizaCloudErrorCode::ConfigurationError,
            Self::Other(_) => ElizaCloudErrorCode::Unknown,
        }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimit { .. }
                | Self::Network(_)
                | Self::Api {
                    status: 500..=599,
                    ..
                }
        )
    }

    pub fn authentication(message: impl Into<String>) -> Self {
        Self::Authentication {
            message: message.into(),
            code: ElizaCloudErrorCode::InvalidApiKey,
        }
    }

    pub fn rate_limit(message: impl Into<String>, retry_after: Option<u32>) -> Self {
        Self::RateLimit {
            message: message.into(),
            retry_after,
        }
    }

    pub fn invalid_request(message: impl Into<String>, errors: Vec<String>) -> Self {
        Self::InvalidRequest {
            message: message.into(),
            errors,
        }
    }

    pub fn api(status: u16, message: impl Into<String>) -> Self {
        Self::Api {
            status,
            message: message.into(),
            body: None,
        }
    }

    pub fn configuration(message: impl Into<String>) -> Self {
        Self::Configuration(message.into())
    }
}

pub type Result<T> = std::result::Result<T, ElizaCloudError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_codes() {
        let auth_err = ElizaCloudError::authentication("Invalid key");
        assert_eq!(auth_err.code(), ElizaCloudErrorCode::InvalidApiKey);

        let rate_err = ElizaCloudError::rate_limit("Too many requests", Some(30));
        assert_eq!(rate_err.code(), ElizaCloudErrorCode::RateLimitExceeded);
        assert!(rate_err.is_retryable());

        let api_err = ElizaCloudError::api(503, "Service unavailable");
        assert!(api_err.is_retryable());

        let bad_request = ElizaCloudError::api(400, "Bad request");
        assert!(!bad_request.is_retryable());
    }
}
