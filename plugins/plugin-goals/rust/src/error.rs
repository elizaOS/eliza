//! Error types for the Goals plugin
//!
//! Provides strongly-typed errors that fail fast with clear messages.

use std::fmt;
use thiserror::Error;

/// Result type alias for Goal operations
pub type Result<T> = std::result::Result<T, GoalError>;

/// Goals plugin error types
///
/// All errors are designed to fail fast with clear, actionable messages.
#[derive(Debug, Error)]
pub enum GoalError {
    /// Goal not found
    #[error("Goal not found: {0}")]
    NotFound(String),

    /// Goal already exists
    #[error("Goal already exists: {0}")]
    AlreadyExists(String),

    /// Invalid goal data
    #[error("Invalid goal data: {0}")]
    InvalidData(String),

    /// Goal is already completed
    #[error("Goal is already completed: {0}")]
    AlreadyCompleted(String),

    /// Goal is already cancelled
    #[error("Goal is already cancelled: {0}")]
    AlreadyCancelled(String),

    /// Database error
    #[error("Database error: {0}")]
    DatabaseError(String),

    /// Validation error
    #[error("Validation error: {0}")]
    ValidationError(String),

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),

    /// Serialization error
    #[error("Serialization error: {0}")]
    SerializationError(String),
}

impl GoalError {
    /// Check if error is retryable
    pub fn is_retryable(&self) -> bool {
        matches!(self, GoalError::DatabaseError(_))
    }
}

impl From<serde_json::Error> for GoalError {
    fn from(err: serde_json::Error) -> Self {
        GoalError::SerializationError(err.to_string())
    }
}

impl From<std::io::Error> for GoalError {
    fn from(err: std::io::Error) -> Self {
        GoalError::Internal(format!("I/O error: {}", err))
    }
}

/// Error context wrapper for adding contextual information
#[derive(Debug)]
pub struct ErrorContext<E: fmt::Display> {
    error: E,
    context: String,
}

impl<E: fmt::Display> fmt::Display for ErrorContext<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.context, self.error)
    }
}

impl<E: fmt::Display + fmt::Debug> std::error::Error for ErrorContext<E> {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = GoalError::NotFound("goal-123".to_string());
        assert!(err.to_string().contains("goal-123"));
    }

    #[test]
    fn test_error_retryable() {
        assert!(GoalError::DatabaseError("connection failed".to_string()).is_retryable());
        assert!(!GoalError::NotFound("goal-123".to_string()).is_retryable());
    }
}
