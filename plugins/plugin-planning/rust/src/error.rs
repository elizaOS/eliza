#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, PlanningError>;

#[derive(Error, Debug)]
pub enum PlanningError {
    #[error("Memory manager not available")]
    ManagerUnavailable,

    #[error("Plan not found: {0}")]
    PlanNotFound(String),

    #[error("Task not found: {0}")]
    TaskNotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),
}
