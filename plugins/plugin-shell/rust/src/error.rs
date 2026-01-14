#![allow(missing_docs)]

use thiserror::Error;

#[derive(Error, Debug)]
pub enum ShellError {
    /// Shell is disabled
    #[error("Shell plugin is disabled. Set SHELL_ENABLED=true to enable.")]
    Disabled,

    #[error("Invalid command: {0}")]
    InvalidCommand(String),

    #[error("Security policy violation: {0}")]
    SecurityViolation(String),

    #[error("Command is forbidden by security policy")]
    ForbiddenCommand,

    #[error("Cannot navigate outside allowed directory")]
    PathValidationFailed,

    #[error("Command execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Command execution timeout")]
    Timeout,

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Configuration error: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, ShellError>;
