use std::fmt;
use thiserror::Error;

/// A specialized Result type for goal operations.
///
/// This type alias is used throughout the goals plugin to represent
/// operations that may fail with a `GoalError`.
pub type Result<T> = std::result::Result<T, GoalError>;

/// Errors that can occur during goal operations.
///
/// This enum represents all possible error conditions that may arise
/// when working with goals, including not found, validation, and
/// database errors.
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
    /// Checks if this error is potentially recoverable by retrying the operation.
    ///
    /// Currently, only `DatabaseError` is considered retryable, as it may
    /// represent transient connection issues.
    ///
    /// # Returns
    ///
    /// `true` if the operation should be retried, `false` otherwise.
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

/// Wraps an error with additional context information.
///
/// This struct is useful for adding contextual information to errors
/// without losing the original error type.
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
