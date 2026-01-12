#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, PlanningError>;

#[derive(Error, Debug)]
pub enum PlanningError {
    #[error("Invalid planning context: {0}")]
    InvalidContext(String),

    #[error("Plan validation failed: {0}")]
    ValidationFailed(String),

    #[error("Plan execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Action not found: {0}")]
    ActionNotFound(String),

    #[error("Circular dependency detected in plan")]
    CircularDependency,

    #[error("Plan execution was cancelled")]
    Cancelled,

    #[error("Plan execution timed out")]
    Timeout,

    #[error("Model error: {0}")]
    Model(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("{0}")]
    General(String),
}


