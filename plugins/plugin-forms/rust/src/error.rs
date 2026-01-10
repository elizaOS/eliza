//! Error types for the elizaOS Forms Plugin.

use thiserror::Error;

/// Errors that can occur during form operations.
#[derive(Error, Debug)]
pub enum FormsError {
    /// Template not found.
    #[error("Template not found: {0}")]
    TemplateNotFound(String),

    /// Form not found.
    #[error("Form not found: {0}")]
    FormNotFound(String),

    /// Form is not active.
    #[error("Form is not active")]
    FormNotActive,

    /// Validation error.
    #[error("Validation error: {0}")]
    ValidationError(String),

    /// Parse error.
    #[error("Parse error: {0}")]
    ParseError(String),

    /// LLM error.
    #[error("LLM error: {0}")]
    LlmError(String),

    /// Serialization error.
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

/// Result type for form operations.
pub type FormsResult<T> = Result<T, FormsError>;

