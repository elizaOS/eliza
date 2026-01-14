#![allow(missing_docs)]

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroqErrorCode {
    InvalidApiKey,
    RateLimitExceeded,
    InvalidRequest,
    ServerError,
    ParseError,
}

impl std::fmt::Display for GroqErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidApiKey => write!(f, "INVALID_API_KEY"),
            Self::RateLimitExceeded => write!(f, "RATE_LIMIT_EXCEEDED"),
            Self::InvalidRequest => write!(f, "INVALID_REQUEST"),
            Self::ServerError => write!(f, "SERVER_ERROR"),
            Self::ParseError => write!(f, "PARSE_ERROR"),
        }
    }
}

#[derive(Error, Debug)]
pub enum GroqError {
    #[error("Authentication failed: {message}")]
    Authentication {
        message: String,
        code: GroqErrorCode,
    },

    #[error("Rate limit exceeded, retry after {retry_after:?}s")]
    RateLimit {
        retry_after: Option<f64>,
        code: GroqErrorCode,
    },

    #[error("Request error: {message}")]
    Request {
        message: String,
        status_code: u16,
        code: GroqErrorCode,
    },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Parse error: {0}")]
    Parse(#[from] serde_json::Error),

    #[error("Config error: {0}")]
    Config(String),
}

impl GroqError {
    pub fn code(&self) -> GroqErrorCode {
        match self {
            Self::Authentication { code, .. } => *code,
            Self::RateLimit { code, .. } => *code,
            Self::Request { code, .. } => *code,
            Self::Network(_) => GroqErrorCode::ServerError,
            Self::Parse(_) => GroqErrorCode::ParseError,
            Self::Config(_) => GroqErrorCode::InvalidRequest,
        }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::RateLimit { .. } | Self::Network(_))
    }

    pub fn retry_delay_ms(&self) -> Option<u64> {
        match self {
            Self::RateLimit {
                retry_after: Some(secs),
                ..
            } => Some((*secs * 1000.0) as u64 + 1000),
            Self::RateLimit { .. } => Some(10000),
            Self::Network(_) => Some(1000),
            _ => None,
        }
    }
}
