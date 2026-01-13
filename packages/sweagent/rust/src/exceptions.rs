//! Error types for SWE-agent
//!
//! This module defines all error types used throughout the SWE-agent implementation.

use thiserror::Error;

/// Main error type for SWE-agent operations
#[derive(Error, Debug)]
pub enum SWEAgentError {
    // Cost and limit errors
    #[error("Instance cost limit exceeded: {0}")]
    InstanceCostLimitExceeded(String),

    #[error("Total cost limit exceeded: {0}")]
    TotalCostLimitExceeded(String),

    #[error("Instance call limit exceeded: {0}")]
    InstanceCallLimitExceeded(String),

    #[error("Context window exceeded: {0}")]
    ContextWindowExceeded(String),

    // Format and parsing errors
    #[error("Format error: {0}")]
    FormatError(String),

    #[error("Invalid action format: {0}")]
    InvalidActionFormat(String),

    #[error("Blocked action: {0}")]
    BlockedAction(String),

    #[error("Bash syntax error: {0}")]
    BashIncorrectSyntax(String),

    // Execution errors
    #[error("Command timeout after {timeout}s: {command}")]
    CommandTimeout { timeout: u64, command: String },

    #[error("Total execution time exceeded")]
    TotalExecutionTimeExceeded,

    #[error("Environment error: {0}")]
    EnvironmentError(String),

    #[error("Docker error: {0}")]
    DockerError(String),

    #[error("Runtime error: {0}")]
    RuntimeError(String),

    // Agent control flow
    #[error("Retry with output")]
    RetryWithOutput,

    #[error("Retry without output")]
    RetryWithoutOutput,

    #[error("Exit forfeit")]
    ExitForfeit,

    #[error("End of file")]
    EOF,

    // API and network errors
    #[error("API error: {0}")]
    ApiError(String),

    #[error("Content policy violation: {0}")]
    ContentPolicyViolation(String),

    #[error("Network error: {0}")]
    NetworkError(String),

    // Configuration errors
    #[error("Configuration error: {0}")]
    ConfigurationError(String),

    #[error("Invalid configuration: {0}")]
    InvalidConfiguration(String),

    #[error("Missing required field: {0}")]
    MissingField(String),

    // File and IO errors
    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("IO error: {0}")]
    IoError(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    // Git errors
    #[error("Git error: {0}")]
    GitError(String),

    #[error("Invalid GitHub URL: {0}")]
    InvalidGithubUrl(String),

    // Template errors
    #[error("Template error: {0}")]
    TemplateError(String),

    // Generic errors
    #[error("Unknown error: {0}")]
    Unknown(String),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl SWEAgentError {
    /// Check if this error should trigger a retry
    pub fn should_retry(&self) -> bool {
        matches!(
            self,
            SWEAgentError::RetryWithOutput
                | SWEAgentError::RetryWithoutOutput
                | SWEAgentError::FormatError(_)
                | SWEAgentError::BlockedAction(_)
                | SWEAgentError::BashIncorrectSyntax(_)
        )
    }

    /// Check if this error should cause immediate exit
    pub fn should_exit(&self) -> bool {
        matches!(
            self,
            SWEAgentError::ExitForfeit
                | SWEAgentError::TotalExecutionTimeExceeded
                | SWEAgentError::InstanceCostLimitExceeded(_)
                | SWEAgentError::TotalCostLimitExceeded(_)
                | SWEAgentError::InstanceCallLimitExceeded(_)
                | SWEAgentError::ContextWindowExceeded(_)
        )
    }

    /// Get exit status string for this error
    pub fn exit_status(&self) -> &'static str {
        match self {
            SWEAgentError::ExitForfeit => "exit_forfeit",
            SWEAgentError::TotalExecutionTimeExceeded => "exit_total_execution_time",
            SWEAgentError::CommandTimeout { .. } => "exit_command_timeout",
            SWEAgentError::ContextWindowExceeded(_) => "exit_context",
            SWEAgentError::InstanceCostLimitExceeded(_)
            | SWEAgentError::TotalCostLimitExceeded(_)
            | SWEAgentError::InstanceCallLimitExceeded(_) => "exit_cost",
            SWEAgentError::RuntimeError(_) | SWEAgentError::EnvironmentError(_) => {
                "exit_environment_error"
            }
            SWEAgentError::FormatError(_)
            | SWEAgentError::InvalidActionFormat(_)
            | SWEAgentError::BashIncorrectSyntax(_) => "exit_format",
            _ => "exit_error",
        }
    }
}

impl From<std::io::Error> for SWEAgentError {
    fn from(err: std::io::Error) -> Self {
        SWEAgentError::IoError(err.to_string())
    }
}

impl From<serde_json::Error> for SWEAgentError {
    fn from(err: serde_json::Error) -> Self {
        SWEAgentError::SerializationError(err.to_string())
    }
}

impl From<serde_yaml::Error> for SWEAgentError {
    fn from(err: serde_yaml::Error) -> Self {
        SWEAgentError::SerializationError(err.to_string())
    }
}

impl From<reqwest::Error> for SWEAgentError {
    fn from(err: reqwest::Error) -> Self {
        SWEAgentError::NetworkError(err.to_string())
    }
}

impl From<handlebars::RenderError> for SWEAgentError {
    fn from(err: handlebars::RenderError) -> Self {
        SWEAgentError::TemplateError(err.to_string())
    }
}

/// Result type alias for SWE-agent operations
pub type Result<T> = std::result::Result<T, SWEAgentError>;

/// Special tokens used in observations to signal control flow
pub mod tokens {
    pub const RETRY_WITH_OUTPUT: &str = "###SWE-AGENT-RETRY-WITH-OUTPUT###";
    pub const RETRY_WITHOUT_OUTPUT: &str = "###SWE-AGENT-RETRY-WITHOUT-OUTPUT###";
    pub const EXIT_FORFEIT: &str = "###SWE-AGENT-EXIT-FORFEIT###";
    pub const SUBMISSION_MARKER: &str = "<<SWE_AGENT_SUBMISSION>>";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_retry() {
        assert!(SWEAgentError::RetryWithOutput.should_retry());
        assert!(SWEAgentError::FormatError("test".to_string()).should_retry());
        assert!(!SWEAgentError::ExitForfeit.should_retry());
    }

    #[test]
    fn test_should_exit() {
        assert!(SWEAgentError::ExitForfeit.should_exit());
        assert!(SWEAgentError::TotalExecutionTimeExceeded.should_exit());
        assert!(!SWEAgentError::FormatError("test".to_string()).should_exit());
    }

    #[test]
    fn test_exit_status() {
        assert_eq!(SWEAgentError::ExitForfeit.exit_status(), "exit_forfeit");
        assert_eq!(
            SWEAgentError::ContextWindowExceeded("test".to_string()).exit_status(),
            "exit_context"
        );
    }
}
