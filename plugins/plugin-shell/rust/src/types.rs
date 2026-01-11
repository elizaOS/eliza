#![allow(missing_docs)]
//! Type definitions for the shell plugin.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::env;

use crate::error::{ShellError, Result};
use crate::path_utils::DEFAULT_FORBIDDEN_COMMANDS;

/// Type of file operation detected
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOperationType {
    Create,
    Write,
    Read,
    Delete,
    Mkdir,
    Move,
    Copy,
}

/// File operation performed by a command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOperation {
    /// Type of file operation
    #[serde(rename = "type")]
    pub op_type: FileOperationType,
    /// Target file or directory path
    pub target: String,
    /// Secondary target for move/copy operations
    pub secondary_target: Option<String>,
}

/// Result of a command execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    /// Whether the command executed successfully
    pub success: bool,
    /// Standard output from the command
    pub stdout: String,
    /// Standard error output from the command
    pub stderr: String,
    /// Exit code of the command (None if terminated abnormally)
    pub exit_code: Option<i32>,
    /// Error message if command failed
    pub error: Option<String>,
    /// Directory where the command was executed
    pub executed_in: String,
}

impl CommandResult {
    /// Create a new error result
    pub fn error(message: &str, stderr: &str, executed_in: &str) -> Self {
        Self {
            success: false,
            stdout: String::new(),
            stderr: stderr.to_string(),
            exit_code: Some(1),
            error: Some(message.to_string()),
            executed_in: executed_in.to_string(),
        }
    }

    /// Create a new success result
    pub fn success(stdout: String, executed_in: &str) -> Self {
        Self {
            success: true,
            stdout,
            stderr: String::new(),
            exit_code: Some(0),
            error: None,
            executed_in: executed_in.to_string(),
        }
    }
}

/// Entry in the command history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandHistoryEntry {
    /// The command that was executed
    pub command: String,
    /// Standard output from the command
    pub stdout: String,
    /// Standard error output from the command
    pub stderr: String,
    /// Exit code of the command
    pub exit_code: Option<i32>,
    /// Unix timestamp when the command was executed
    pub timestamp: f64,
    /// Working directory when the command was executed
    pub working_directory: String,
    /// File operations performed by the command
    pub file_operations: Option<Vec<FileOperation>>,
}

/// Shell plugin configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellConfig {
    /// Whether the shell plugin is enabled
    pub enabled: bool,
    /// The directory that commands are restricted to
    pub allowed_directory: PathBuf,
    /// Maximum command execution timeout in milliseconds
    pub timeout_ms: u64,
    /// List of forbidden commands/patterns
    pub forbidden_commands: Vec<String>,
}


impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            allowed_directory: env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            timeout_ms: 30000,
            forbidden_commands: DEFAULT_FORBIDDEN_COMMANDS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
}

impl ShellConfig {
    /// Create a new configuration builder
    pub fn builder() -> ShellConfigBuilder {
        ShellConfigBuilder::default()
    }

    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self> {
        let enabled = env::var("SHELL_ENABLED")
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(false);

        let allowed_directory = env::var("SHELL_ALLOWED_DIRECTORY")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let timeout_ms = env::var("SHELL_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30000);

        let custom_forbidden: Vec<String> = env::var("SHELL_FORBIDDEN_COMMANDS")
            .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();

        let mut forbidden_commands: Vec<String> = DEFAULT_FORBIDDEN_COMMANDS
            .iter()
            .map(|s| s.to_string())
            .collect();
        forbidden_commands.extend(custom_forbidden);
        forbidden_commands.sort();
        forbidden_commands.dedup();

        Ok(Self {
            enabled,
            allowed_directory,
            timeout_ms,
            forbidden_commands,
        })
    }
}

/// Builder for ShellConfig
#[derive(Debug, Default)]
pub struct ShellConfigBuilder {
    enabled: Option<bool>,
    allowed_directory: Option<PathBuf>,
    timeout_ms: Option<u64>,
    forbidden_commands: Option<Vec<String>>,
}

impl ShellConfigBuilder {
    /// Set whether the shell is enabled
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = Some(enabled);
        self
    }

    /// Set the allowed directory
    pub fn allowed_directory<P: Into<PathBuf>>(mut self, path: P) -> Self {
        self.allowed_directory = Some(path.into());
        self
    }

    /// Set the timeout in milliseconds
    pub fn timeout_ms(mut self, timeout: u64) -> Self {
        self.timeout_ms = Some(timeout);
        self
    }

    /// Set the forbidden commands
    pub fn forbidden_commands(mut self, commands: Vec<String>) -> Self {
        self.forbidden_commands = Some(commands);
        self
    }

    /// Add a forbidden command
    pub fn add_forbidden_command(mut self, command: String) -> Self {
        let mut commands = self.forbidden_commands.unwrap_or_default();
        commands.push(command);
        self.forbidden_commands = Some(commands);
        self
    }

    /// Build the configuration
    pub fn build(self) -> Result<ShellConfig> {
        let allowed_directory = self.allowed_directory
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        // Validate directory exists
        if !allowed_directory.exists() {
            return Err(ShellError::Config(format!(
                "Allowed directory does not exist: {}",
                allowed_directory.display()
            )));
        }

        if !allowed_directory.is_dir() {
            return Err(ShellError::Config(format!(
                "Allowed path is not a directory: {}",
                allowed_directory.display()
            )));
        }

        let mut forbidden_commands: Vec<String> = DEFAULT_FORBIDDEN_COMMANDS
            .iter()
            .map(|s| s.to_string())
            .collect();

        if let Some(custom) = self.forbidden_commands {
            forbidden_commands.extend(custom);
        }

        forbidden_commands.sort();
        forbidden_commands.dedup();

        Ok(ShellConfig {
            enabled: self.enabled.unwrap_or(false),
            allowed_directory,
            timeout_ms: self.timeout_ms.unwrap_or(30000),
            forbidden_commands,
        })
    }
}




