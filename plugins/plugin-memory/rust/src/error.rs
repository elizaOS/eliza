#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, MemoryError>;

#[derive(Error, Debug)]
pub enum MemoryError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Cache error: {0}")]
    Cache(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    #[error("Memory not found: {0}")]
    NotFound(String),

    #[error("Invalid memory category: {0}")]
    InvalidCategory(String),

    #[error("Model error: {0}")]
    Model(String),

    #[error("{0}")]
    General(String),
}
