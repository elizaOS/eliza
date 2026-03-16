#![allow(missing_docs)]
//! Error types for the Todo Plugin.

use thiserror::Error;

/// Result type alias using TodoError.
pub type Result<T> = std::result::Result<T, TodoError>;

/// Errors that can occur in the todo plugin.
#[derive(Debug, Error)]
pub enum TodoError {
    /// Validation error
    #[error("Validation error: {0}")]
    Validation(String),

    /// Not found error
    #[error("Not found: {0}")]
    NotFound(String),

    /// Database error
    #[error("Database error: {0}")]
    Database(String),

    /// Configuration error
    #[error("Configuration error: {0}")]
    Config(String),

    /// Reminder error
    #[error("Reminder error: {0}")]
    Reminder(String),

    /// Notification error
    #[error("Notification error: {0}")]
    Notification(String),

    /// Serialization error
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Internal error
    #[error("Internal error: {0}")]
    Internal(String),
}

impl TodoError {
    /// Create a validation error.
    pub fn validation<S: Into<String>>(msg: S) -> Self {
        Self::Validation(msg.into())
    }

    /// Create a not found error.
    pub fn not_found<S: Into<String>>(msg: S) -> Self {
        Self::NotFound(msg.into())
    }

    /// Create a database error.
    pub fn database<S: Into<String>>(msg: S) -> Self {
        Self::Database(msg.into())
    }

    /// Create a configuration error.
    pub fn config<S: Into<String>>(msg: S) -> Self {
        Self::Config(msg.into())
    }

    /// Create an internal error.
    pub fn internal<S: Into<String>>(msg: S) -> Self {
        Self::Internal(msg.into())
    }
}
