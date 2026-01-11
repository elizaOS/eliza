//! Error types for the Memory Plugin.

use thiserror::Error;

/// Result type for memory operations.
pub type Result<T> = std::result::Result<T, MemoryError>;

/// Errors that can occur in the memory plugin.
#[derive(Error, Debug)]
pub enum MemoryError {
    /// Database error
    #[error("Database error: {0}")]
    Database(String),

    /// Cache error
    #[error("Cache error: {0}")]
    Cache(String),

    /// Serialization error
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Invalid configuration
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    /// Memory not found
    #[error("Memory not found: {0}")]
    NotFound(String),

    /// Invalid memory category
    #[error("Invalid memory category: {0}")]
    InvalidCategory(String),

    /// Model error
    #[error("Model error: {0}")]
    Model(String),

    /// General error
    #[error("{0}")]
    General(String),
}


