//! Error types for the elizaOS Bootstrap Plugin.

use thiserror::Error;

/// Plugin-specific errors.
#[derive(Debug, Error)]
pub enum PluginError {
    /// An action failed to execute.
    #[error("Action failed: {0}")]
    ActionFailed(String),

    /// A provider failed to get context.
    #[error("Provider failed: {0}")]
    ProviderFailed(String),

    /// An evaluator failed.
    #[error("Evaluator failed: {0}")]
    EvaluatorFailed(String),

    /// A required resource was not found.
    #[error("Not found: {0}")]
    NotFound(String),

    /// Invalid input or state.
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// State is required but was not provided.
    #[error("State required: {0}")]
    StateRequired(String),

    /// XML parsing failed.
    #[error("XML parse error: {0}")]
    XmlParse(String),

    /// Model call failed.
    #[error("Model error: {0}")]
    ModelError(String),

    /// Service is not started.
    #[error("Service not started: {0}")]
    ServiceNotStarted(String),

    /// Internal error.
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Result type for plugin operations.
pub type PluginResult<T> = Result<T, PluginError>;

impl From<serde_json::Error> for PluginError {
    fn from(err: serde_json::Error) -> Self {
        Self::Internal(err.to_string())
    }
}

impl From<quick_xml::DeError> for PluginError {
    fn from(err: quick_xml::DeError) -> Self {
        Self::XmlParse(err.to_string())
    }
}
