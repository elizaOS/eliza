//! Error types for the TTS plugin.

use thiserror::Error;

/// Errors that can occur during TTS operations.
#[derive(Debug, Error)]
pub enum TtsError {
    /// The text-to-speech synthesis failed.
    #[error("TTS synthesis failed with {provider}: {message}")]
    SynthesisFailed {
        provider: String,
        message: String,
    },

    /// No TTS provider is available.
    #[error("No TTS provider available")]
    NoProviderAvailable,

    /// The runtime does not support the required model.
    #[error("Runtime does not support use_model")]
    RuntimeUnsupported,

    /// The text is too short for TTS.
    #[error("Text too short for TTS (length {length}, minimum {minimum})")]
    TextTooShort {
        length: usize,
        minimum: usize,
    },

    /// Configuration error.
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// JSON parsing error.
    #[error("JSON parse error: {0}")]
    JsonError(#[from] serde_json::Error),
}

/// Convenience alias for TTS results.
pub type TtsResult<T> = Result<T, TtsError>;
