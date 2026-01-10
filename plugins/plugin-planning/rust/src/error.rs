//! Error types for the Planning Plugin.

use thiserror::Error;

/// Result type for planning operations.
pub type Result<T> = std::result::Result<T, PlanningError>;

/// Errors that can occur in the planning plugin.
#[derive(Error, Debug)]
pub enum PlanningError {
    /// Invalid planning context
    #[error("Invalid planning context: {0}")]
    InvalidContext(String),

    /// Plan validation failed
    #[error("Plan validation failed: {0}")]
    ValidationFailed(String),

    /// Plan execution failed
    #[error("Plan execution failed: {0}")]
    ExecutionFailed(String),

    /// Action not found
    #[error("Action not found: {0}")]
    ActionNotFound(String),

    /// Circular dependency detected
    #[error("Circular dependency detected in plan")]
    CircularDependency,

    /// Plan cancelled
    #[error("Plan execution was cancelled")]
    Cancelled,

    /// Timeout exceeded
    #[error("Plan execution timed out")]
    Timeout,

    /// Model error
    #[error("Model error: {0}")]
    Model(String),

    /// Serialization error
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Parse error
    #[error("Parse error: {0}")]
    Parse(String),

    /// General error
    #[error("{0}")]
    General(String),
}

