#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, FarcasterError>;

#[derive(Error, Debug)]
pub enum FarcasterError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("API error: {message} (status: {status_code:?}, code: {error_code:?})")]
    Api {
        message: String,
        status_code: Option<u16>,
        error_code: Option<String>,
    },

    #[error("Rate limit exceeded (retry after: {retry_after:?}s)")]
    RateLimit { retry_after: Option<u64> },

    #[error("Cast error: {0}")]
    Cast(String),

    #[error("Profile error: {0}")]
    Profile(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Environment error: {0}")]
    Env(String),

    #[error("{0}")]
    Other(String),
}

impl FarcasterError {
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    pub fn api(
        message: impl Into<String>,
        status_code: Option<u16>,
        error_code: Option<String>,
    ) -> Self {
        Self::Api {
            message: message.into(),
            status_code,
            error_code,
        }
    }

    pub fn rate_limit(retry_after: Option<u64>) -> Self {
        Self::RateLimit { retry_after }
    }

    pub fn cast(msg: impl Into<String>) -> Self {
        Self::Cast(msg.into())
    }

    pub fn profile(msg: impl Into<String>) -> Self {
        Self::Profile(msg.into())
    }

    pub fn env(msg: impl Into<String>) -> Self {
        Self::Env(msg.into())
    }

    pub fn is_rate_limit(&self) -> bool {
        matches!(self, Self::RateLimit { .. })
    }

    pub fn is_network(&self) -> bool {
        matches!(self, Self::Network(_))
    }

    pub fn is_config(&self) -> bool {
        matches!(self, Self::Config(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = FarcasterError::config("missing API key");
        assert!(err.to_string().contains("missing API key"));
        assert!(err.is_config());
    }

    #[test]
    fn test_rate_limit_error() {
        let err = FarcasterError::rate_limit(Some(60));
        assert!(err.is_rate_limit());
        assert!(err.to_string().contains("60"));
    }

    #[test]
    fn test_api_error() {
        let err = FarcasterError::api("Not found", Some(404), Some("not_found".to_string()));
        assert!(err.to_string().contains("Not found"));
        assert!(err.to_string().contains("404"));
    }
}
