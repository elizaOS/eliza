#![allow(missing_docs)]
//! Configuration for the Scratchpad Plugin.

use crate::error::{Result, ScratchpadError};
use std::env;
use std::path::PathBuf;

/// Configuration for the scratchpad service.
#[derive(Debug, Clone)]
pub struct ScratchpadConfig {
    /// Base directory for scratchpad files
    pub base_path: String,

    /// Maximum file size in bytes
    pub max_file_size: usize,

    /// Allowed file extensions
    pub allowed_extensions: Vec<String>,
}

impl Default for ScratchpadConfig {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let base_path = home.join(".eliza").join("scratchpad");

        Self {
            base_path: base_path.to_string_lossy().into_owned(),
            max_file_size: 1024 * 1024, // 1MB
            allowed_extensions: vec![".md".to_string(), ".txt".to_string()],
        }
    }
}

impl ScratchpadConfig {
    /// Create a new configuration with defaults.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create configuration from environment variables.
    ///
    /// # Environment Variables
    ///
    /// - `SCRATCHPAD_BASE_PATH`: Base directory for scratchpad files
    /// - `SCRATCHPAD_MAX_FILE_SIZE`: Maximum file size in bytes (default: 1048576)
    /// - `SCRATCHPAD_ALLOWED_EXTENSIONS`: Comma-separated extensions (default: .md,.txt)
    ///
    /// # Errors
    ///
    /// Returns an error if configuration values are invalid.
    pub fn from_env() -> Result<Self> {
        let default = Self::default();

        let base_path = env::var("SCRATCHPAD_BASE_PATH").unwrap_or(default.base_path);

        let max_file_size = env::var("SCRATCHPAD_MAX_FILE_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default.max_file_size);

        let allowed_extensions = env::var("SCRATCHPAD_ALLOWED_EXTENSIONS")
            .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or(default.allowed_extensions);

        let config = Self {
            base_path,
            max_file_size,
            allowed_extensions,
        };

        config.validate()?;
        Ok(config)
    }

    /// Validate the configuration.
    ///
    /// # Errors
    ///
    /// Returns an error if configuration is invalid.
    pub fn validate(&self) -> Result<()> {
        if self.max_file_size < 1024 {
            return Err(ScratchpadError::config(
                "max_file_size must be at least 1024 bytes",
            ));
        }

        if self.allowed_extensions.is_empty() {
            return Err(ScratchpadError::config(
                "allowed_extensions must not be empty",
            ));
        }

        for ext in &self.allowed_extensions {
            if !ext.starts_with('.') {
                return Err(ScratchpadError::config(format!(
                    "Extension must start with '.': {}",
                    ext
                )));
            }
        }

        Ok(())
    }

    /// Builder method to set the base path.
    pub fn with_base_path<S: Into<String>>(mut self, path: S) -> Self {
        self.base_path = path.into();
        self
    }

    /// Builder method to set the max file size.
    pub fn with_max_file_size(mut self, size: usize) -> Self {
        self.max_file_size = size;
        self
    }
}
