#![allow(missing_docs)]

use thiserror::Error;

#[derive(Error, Debug)]
pub enum FormsError {
    #[error("Template not found: {0}")]
    TemplateNotFound(String),
    #[error("Form not found: {0}")]
    FormNotFound(String),
    #[error("Form is not active")]
    FormNotActive,
    #[error("Validation error: {0}")]
    ValidationError(String),
    #[error("Parse error: {0}")]
    ParseError(String),
    #[error("LLM error: {0}")]
    LlmError(String),
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

pub type FormsResult<T> = Result<T, FormsError>;

