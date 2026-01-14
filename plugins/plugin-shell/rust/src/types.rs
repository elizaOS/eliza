#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;

use crate::error::{Result, ShellError};
use crate::path_utils::DEFAULT_FORBIDDEN_COMMANDS;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOperation {
    #[serde(rename = "type")]
    pub op_type: FileOperationType,
    pub target: String,
    pub secondary_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub executed_in: String,
}

impl CommandResult {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandHistoryEntry {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timestamp: f64,
    pub working_directory: String,
    pub file_operations: Option<Vec<FileOperation>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellConfig {
    pub enabled: bool,
    pub allowed_directory: PathBuf,
    pub timeout_ms: u64,
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
    pub fn builder() -> ShellConfigBuilder {
        ShellConfigBuilder::default()
    }

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

#[derive(Debug, Default)]
pub struct ShellConfigBuilder {
    enabled: Option<bool>,
    allowed_directory: Option<PathBuf>,
    timeout_ms: Option<u64>,
    forbidden_commands: Option<Vec<String>>,
}

impl ShellConfigBuilder {
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = Some(enabled);
        self
    }

    pub fn allowed_directory<P: Into<PathBuf>>(mut self, path: P) -> Self {
        self.allowed_directory = Some(path.into());
        self
    }

    pub fn timeout_ms(mut self, timeout: u64) -> Self {
        self.timeout_ms = Some(timeout);
        self
    }

    pub fn forbidden_commands(mut self, commands: Vec<String>) -> Self {
        self.forbidden_commands = Some(commands);
        self
    }

    pub fn add_forbidden_command(mut self, command: String) -> Self {
        let mut commands = self.forbidden_commands.unwrap_or_default();
        commands.push(command);
        self.forbidden_commands = Some(commands);
        self
    }

    pub fn build(self) -> Result<ShellConfig> {
        let allowed_directory = self
            .allowed_directory
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

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
