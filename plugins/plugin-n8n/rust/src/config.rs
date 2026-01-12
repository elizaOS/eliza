#![allow(missing_docs)]

use std::path::PathBuf;

use crate::error::{N8nError, Result};
use crate::models::ClaudeModel;

#[derive(Debug, Clone)]
pub struct N8nConfig {
    pub api_key: String,
    pub model: ClaudeModel,
    pub data_dir: PathBuf,
    pub max_iterations: u32,
    pub max_concurrent_jobs: usize,
    pub job_timeout_seconds: u64,
    pub rate_limit_per_hour: u32,
}

impl Default for N8nConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            model: ClaudeModel::default(),
            data_dir: PathBuf::from("data"),
            max_iterations: 5,
            max_concurrent_jobs: 10,
            job_timeout_seconds: 30 * 60, // 30 minutes
            rate_limit_per_hour: 10,
        }
    }
}

impl N8nConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            ..Default::default()
        }
    }

    pub fn from_env() -> Result<Self> {
        let api_key =
            std::env::var("ANTHROPIC_API_KEY").map_err(|_| N8nError::api_key("ANTHROPIC"))?;

        let model = std::env::var("CLAUDE_MODEL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_default();

        let data_dir = std::env::var("PLUGIN_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data"));

        Ok(Self {
            api_key,
            model,
            data_dir,
            ..Default::default()
        })
    }

    /// Set the Claude model.
    pub fn with_model(mut self, model: ClaudeModel) -> Self {
        self.model = model;
        self
    }

    pub fn with_data_dir(mut self, data_dir: impl Into<PathBuf>) -> Self {
        self.data_dir = data_dir.into();
        self
    }

    pub fn with_max_iterations(mut self, max_iterations: u32) -> Self {
        self.max_iterations = max_iterations;
        self
    }

    /// Get the plugins directory.
    pub fn get_plugins_dir(&self) -> PathBuf {
        self.data_dir.join("plugins")
    }

    pub fn validate(&self) -> Result<()> {
        if self.api_key.is_empty() {
            return Err(N8nError::api_key("ANTHROPIC"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_new() {
        let config = N8nConfig::new("test-key");
        assert_eq!(config.api_key, "test-key");
        assert_eq!(config.model, ClaudeModel::default());
    }

    #[test]
    fn test_config_with_model() {
        let config = N8nConfig::new("test-key").with_model(ClaudeModel::Sonnet35);
        assert_eq!(config.model, ClaudeModel::Sonnet35);
    }

    #[test]
    fn test_config_with_data_dir() {
        let config = N8nConfig::new("test-key").with_data_dir("/custom/path");
        assert_eq!(config.data_dir, PathBuf::from("/custom/path"));
    }

    #[test]
    fn test_config_validate_empty_key() {
        let config = N8nConfig::default();
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_config_validate_valid() {
        let config = N8nConfig::new("test-key");
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_get_plugins_dir() {
        let config = N8nConfig::new("test-key").with_data_dir("/data");
        assert_eq!(config.get_plugins_dir(), PathBuf::from("/data/plugins"));
    }
}
