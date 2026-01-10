//! Error types for the Local AI plugin.

use thiserror::Error;

/// Result type for Local AI operations.
pub type Result<T> = std::result::Result<T, LocalAIError>;

/// Errors that can occur in the Local AI plugin.
#[derive(Error, Debug)]
pub enum LocalAIError {
    /// Model file not found.
    #[error("Model not found: {0}")]
    ModelNotFound(String),

    /// Failed to load model.
    #[error("Failed to load model: {0}")]
    ModelLoadError(String),

    /// Inference error.
    #[error("Inference failed: {0}")]
    InferenceError(String),

    /// Invalid configuration.
    #[error("Invalid configuration: {0}")]
    ConfigError(String),

    /// IO error.
    #[error("IO error: {0}")]
    IoError(String),

    /// Tokenization error.
    #[error("Tokenization failed: {0}")]
    TokenizationError(String),
}

