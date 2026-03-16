#![allow(missing_docs)]

use thiserror::Error;

/// Type alias for `Result` with [`LocalEmbeddingError`].
pub type Result<T> = std::result::Result<T, LocalEmbeddingError>;

/// Errors that can occur in the local embedding plugin.
#[derive(Error, Debug)]
pub enum LocalEmbeddingError {
    /// Configuration-related error.
    #[error("Configuration error: {message}")]
    ConfigError {
        /// Human-readable description of the configuration problem.
        message: String,
    },

    /// Failed to load or initialize a model.
    #[error("Model loading error: {message}")]
    ModelLoadError {
        /// Details about the loading failure.
        message: String,
    },

    /// Error during embedding generation.
    #[error("Embedding generation error: {message}")]
    EmbeddingError {
        /// Details about the embedding failure.
        message: String,
    },

    /// Error during tokenization (encode or decode).
    #[error("Tokenization error: {message}")]
    TokenizationError {
        /// Details about the tokenization failure.
        message: String,
    },

    /// Filesystem I/O error.
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

impl LocalEmbeddingError {
    /// Create a [`ConfigError`](Self::ConfigError) variant.
    pub fn config<S: Into<String>>(message: S) -> Self {
        Self::ConfigError {
            message: message.into(),
        }
    }

    /// Create a [`ModelLoadError`](Self::ModelLoadError) variant.
    pub fn model_load<S: Into<String>>(message: S) -> Self {
        Self::ModelLoadError {
            message: message.into(),
        }
    }

    /// Create an [`EmbeddingError`](Self::EmbeddingError) variant.
    pub fn embedding<S: Into<String>>(message: S) -> Self {
        Self::EmbeddingError {
            message: message.into(),
        }
    }

    /// Create a [`TokenizationError`](Self::TokenizationError) variant.
    pub fn tokenization<S: Into<String>>(message: S) -> Self {
        Self::TokenizationError {
            message: message.into(),
        }
    }
}
