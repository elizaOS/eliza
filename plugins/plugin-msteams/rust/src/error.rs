//! Error types for the MS Teams plugin.

use thiserror::Error;

/// Result type alias using MSTeamsError.
pub type Result<T> = std::result::Result<T, MSTeamsError>;

/// Errors that can occur in the MS Teams plugin.
#[derive(Debug, Error)]
pub enum MSTeamsError {
    /// Missing required configuration setting.
    #[error("Missing required setting: {0}")]
    MissingSetting(String),

    /// Configuration validation error.
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// Bot Framework API error.
    #[error("Bot Framework API error: {0}")]
    ApiError(String),

    /// Authentication error.
    #[error("Authentication error: {0}")]
    AuthError(String),

    /// Connection failed.
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Conversation not found.
    #[error("Conversation not found: {0}")]
    ConversationNotFound(String),

    /// User not found.
    #[error("User not found: {0}")]
    UserNotFound(String),

    /// Invalid argument provided.
    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    /// Service not initialized.
    #[error("Service not initialized")]
    NotInitialized,

    /// Service already running.
    #[error("Service already running")]
    AlreadyRunning,

    /// HTTP request error.
    #[error("HTTP error: {0}")]
    HttpError(String),

    /// JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    JsonError(String),

    /// Graph API error.
    #[error("Graph API error: {0}")]
    GraphError(String),

    /// File upload error.
    #[error("File upload error: {0}")]
    UploadError(String),

    /// Webhook server error.
    #[error("Webhook server error: {0}")]
    WebhookError(String),

    /// Token error.
    #[error("Token error: {0}")]
    TokenError(String),

    /// Rate limited.
    #[error("Rate limited: retry after {0}ms")]
    RateLimited(u64),

    /// Unknown error.
    #[error("Unknown error: {0}")]
    Unknown(String),
}

impl From<reqwest::Error> for MSTeamsError {
    fn from(err: reqwest::Error) -> Self {
        MSTeamsError::HttpError(err.to_string())
    }
}

impl From<serde_json::Error> for MSTeamsError {
    fn from(err: serde_json::Error) -> Self {
        MSTeamsError::JsonError(err.to_string())
    }
}

impl From<std::io::Error> for MSTeamsError {
    fn from(err: std::io::Error) -> Self {
        MSTeamsError::Unknown(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = MSTeamsError::MissingSetting("MSTEAMS_APP_ID".to_string());
        assert!(err.to_string().contains("MSTEAMS_APP_ID"));
    }
}
