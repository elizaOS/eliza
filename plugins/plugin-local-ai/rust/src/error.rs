#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, LocalAIError>;

#[derive(Error, Debug)]
pub enum LocalAIError {
    #[error("Model not found: {0}")]
    ModelNotFound(String),

    #[error("Failed to load model: {0}")]
    ModelLoadError(String),

    #[error("Inference failed: {0}")]
    InferenceError(String),

    #[error("Invalid configuration: {0}")]
    ConfigError(String),

    #[error("IO error: {0}")]
    IoError(String),

    #[error("Tokenization failed: {0}")]
    TokenizationError(String),
}
