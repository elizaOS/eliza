#![allow(missing_docs)]
//! Error types for the N8n Plugin.

use thiserror::Error;

/// Result type for N8n operations.
pub type Result<T> = std::result::Result<T, N8nError>;

/// Error types for the N8n plugin.
#[derive(Error, Debug)]
pub enum N8nError {
    /// Configuration error.
    #[error("Configuration error: {0}")]
    Config(String),

    /// API key not configured.
    #[error("{provider}_API_KEY is not configured. Please set it to enable AI-powered plugin generation.")]
    ApiKey {
        /// The provider name (e.g., "ANTHROPIC").
        provider: String,
    },

    /// Validation error.
    #[error("Validation error for {field}: {message}")]
    Validation {
        /// The field that failed validation.
        field: String,
        /// The validation error message.
        message: String,
    },

    /// Invalid plugin name.
    #[error("Invalid plugin name: {name}. Must follow format: @scope/plugin-name")]
    InvalidPluginName {
        /// The invalid plugin name.
        name: String,
    },

    /// Plugin already exists.
    #[error("Plugin {name} has already been created in this session")]
    PluginExists {
        /// The plugin name.
        name: String,
    },

    /// Rate limit exceeded.
    #[error("Rate limit exceeded. Please wait before creating another plugin.")]
    RateLimit,

    /// Maximum concurrent jobs reached.
    #[error("Maximum number of concurrent jobs ({max_jobs}) reached. Please wait for existing jobs to complete.")]
    MaxConcurrentJobs {
        /// Maximum number of jobs allowed.
        max_jobs: usize,
    },

    /// Job error.
    #[error("Job {job_id}: {message}")]
    Job {
        /// The job ID.
        job_id: String,
        /// The error message.
        message: String,
    },

    /// Job not found.
    #[error("Job {job_id} not found")]
    JobNotFound {
        /// The job ID.
        job_id: String,
    },

    /// HTTP request error.
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// IO error.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Command execution error.
    #[error("Command execution error: {0}")]
    Command(String),

    /// Timeout error.
    #[error("Operation timed out")]
    Timeout,

    /// AI generation error.
    #[error("AI generation error: {0}")]
    Generation(String),

    /// Build error.
    #[error("Build error: {0}")]
    Build(String),

    /// Test error.
    #[error("Test error: {0}")]
    Test(String),

    /// Validation failed.
    #[error("Validation failed: {0}")]
    ValidationFailed(String),
}

impl N8nError {
    /// Create an API key error.
    pub fn api_key(provider: impl Into<String>) -> Self {
        Self::ApiKey {
            provider: provider.into(),
        }
    }

    /// Create a validation error.
    pub fn validation(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Validation {
            field: field.into(),
            message: message.into(),
        }
    }

    /// Create an invalid plugin name error.
    pub fn invalid_plugin_name(name: impl Into<String>) -> Self {
        Self::InvalidPluginName { name: name.into() }
    }

    /// Create a plugin exists error.
    pub fn plugin_exists(name: impl Into<String>) -> Self {
        Self::PluginExists { name: name.into() }
    }

    /// Create a job error.
    pub fn job(job_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Job {
            job_id: job_id.into(),
            message: message.into(),
        }
    }

    /// Create a job not found error.
    pub fn job_not_found(job_id: impl Into<String>) -> Self {
        Self::JobNotFound {
            job_id: job_id.into(),
        }
    }
}







