#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, N8nError>;

#[derive(Error, Debug)]
pub enum N8nError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("{provider}_API_KEY is not configured.")]
    ApiKey { provider: String },

    #[error("Validation error for {field}: {message}")]
    Validation { field: String, message: String },

    #[error("Invalid plugin name: {name}. Must follow format: @scope/plugin-name")]
    InvalidPluginName { name: String },

    #[error("Plugin {name} has already been created in this session")]
    PluginExists { name: String },

    #[error("Rate limit exceeded. Please wait before creating another plugin.")]
    RateLimit,

    #[error("Maximum number of concurrent jobs ({max_jobs}) reached. Please wait for existing jobs to complete.")]
    MaxConcurrentJobs { max_jobs: usize },

    #[error("Job {job_id}: {message}")]
    Job { job_id: String, message: String },

    #[error("Job {job_id} not found")]
    JobNotFound { job_id: String },

    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Command execution error: {0}")]
    Command(String),

    #[error("Operation timed out")]
    Timeout,

    #[error("Generation error: {0}")]
    Generation(String),

    #[error("Build error: {0}")]
    Build(String),

    #[error("Test error: {0}")]
    Test(String),

    #[error("Validation failed: {0}")]
    ValidationFailed(String),
}

impl N8nError {
    pub fn api_key(provider: impl Into<String>) -> Self {
        Self::ApiKey {
            provider: provider.into(),
        }
    }

    pub fn validation(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Validation {
            field: field.into(),
            message: message.into(),
        }
    }

    pub fn invalid_plugin_name(name: impl Into<String>) -> Self {
        Self::InvalidPluginName { name: name.into() }
    }

    pub fn plugin_exists(name: impl Into<String>) -> Self {
        Self::PluginExists { name: name.into() }
    }

    pub fn job(job_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Job {
            job_id: job_id.into(),
            message: message.into(),
        }
    }

    pub fn job_not_found(job_id: impl Into<String>) -> Self {
        Self::JobNotFound {
            job_id: job_id.into(),
        }
    }
}
