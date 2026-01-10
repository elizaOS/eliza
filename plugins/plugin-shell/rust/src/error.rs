//! Error types for the shell plugin.

use thiserror::Error;

/// Shell plugin errors
#[derive(Error, Debug)]
pub enum ShellError {
    /// Shell is disabled
    #[error("Shell plugin is disabled. Set SHELL_ENABLED=true to enable.")]
    Disabled,

    /// Invalid command
    #[error("Invalid command: {0}")]
    InvalidCommand(String),

    /// Security policy violation
    #[error("Security policy violation: {0}")]
    SecurityViolation(String),

    /// Forbidden command
    #[error("Command is forbidden by security policy")]
    ForbiddenCommand,

    /// Path validation failed
    #[error("Cannot navigate outside allowed directory")]
    PathValidationFailed,

    /// Command execution failed
    #[error("Command execution failed: {0}")]
    ExecutionFailed(String),

    /// Command timed out
    #[error("Command execution timeout")]
    Timeout,

    /// IO error
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Configuration error
    #[error("Configuration error: {0}")]
    Config(String),
}

/// Result type alias
pub type Result<T> = std::result::Result<T, ShellError>;

