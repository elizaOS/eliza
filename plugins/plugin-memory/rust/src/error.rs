#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, MemoryError>;

#[derive(Error, Debug)]
pub enum MemoryError {
    #[error("Memory manager not available")]
    ManagerUnavailable,

    #[error("Memory not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Memory encoding error: {0}")]
    Encoding(String),
}
