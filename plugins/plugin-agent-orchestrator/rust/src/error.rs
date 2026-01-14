//! Error types for the Agent Orchestrator plugin.

use thiserror::Error;

/// Errors that can occur in the orchestrator
#[derive(Error, Debug)]
pub enum OrchestratorError {
    #[error("Orchestrator not configured. Call configure_agent_orchestrator_plugin() before runtime.initialize()")]
    NotConfigured,

    #[error("Unknown provider: {0}. Available: {1}")]
    UnknownProvider(String, String),

    #[error("Task not found: {0}")]
    TaskNotFound(String),

    #[error("Provider not found: {0}")]
    ProviderNotFound(String),

    #[error("Runtime error: {0}")]
    RuntimeError(String),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    #[error("Task execution failed: {0}")]
    ExecutionFailed(String),
}

pub type Result<T> = std::result::Result<T, OrchestratorError>;
