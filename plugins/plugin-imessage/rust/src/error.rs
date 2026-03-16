//! Error types for the iMessage plugin

use thiserror::Error;

/// Result type for iMessage operations
pub type Result<T> = std::result::Result<T, IMessageError>;

/// Errors that can occur in the iMessage plugin
#[derive(Error, Debug)]
pub enum IMessageError {
    /// Not supported on this platform
    #[error("iMessage is only supported on macOS")]
    NotSupported,

    /// Configuration error
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// AppleScript error
    #[error("AppleScript error: {0}")]
    AppleScriptError(String),

    /// CLI tool error
    #[error("CLI error (code {exit_code:?}): {message}")]
    CliError {
        message: String,
        exit_code: Option<i32>,
    },

    /// Message sending error
    #[error("Failed to send message: {0}")]
    SendError(String),

    /// Invalid target
    #[error("Invalid iMessage target: {0}")]
    InvalidTarget(String),

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// IO error
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

impl IMessageError {
    /// Creates a new configuration error
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError(message.into())
    }

    /// Creates a new AppleScript error
    pub fn applescript<S: Into<String>>(message: S) -> Self {
        Self::AppleScriptError(message.into())
    }

    /// Creates a new CLI error
    pub fn cli<S: Into<String>>(message: S, exit_code: Option<i32>) -> Self {
        Self::CliError {
            message: message.into(),
            exit_code,
        }
    }

    /// Creates a new send error
    pub fn send<S: Into<String>>(message: S) -> Self {
        Self::SendError(message.into())
    }

    /// Creates a new invalid target error
    pub fn invalid_target<S: Into<String>>(target: S) -> Self {
        Self::InvalidTarget(target.into())
    }

    /// Creates a new permission denied error
    pub fn permission_denied<S: Into<String>>(message: S) -> Self {
        Self::PermissionDenied(message.into())
    }

    /// Creates a new internal error
    pub fn internal<S: Into<String>>(message: S) -> Self {
        Self::Internal(message.into())
    }
}
