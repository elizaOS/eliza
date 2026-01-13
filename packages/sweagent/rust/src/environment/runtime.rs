//! Runtime abstractions for command execution

use crate::exceptions::{Result, SWEAgentError};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A bash action to execute
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashAction {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl BashAction {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            timeout: None,
            cwd: None,
        }
    }

    pub fn with_timeout(mut self, timeout: u64) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

/// Result of a bash action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashActionResult {
    pub output: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

impl BashActionResult {
    pub fn success(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            exit_code: 0,
            timed_out: false,
        }
    }

    pub fn failure(output: impl Into<String>, exit_code: i32) -> Self {
        Self {
            output: output.into(),
            exit_code,
            timed_out: false,
        }
    }

    pub fn timeout(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            exit_code: -1,
            timed_out: true,
        }
    }
}

/// Bash interrupt action
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BashInterruptAction;

/// Request to create a bash session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateBashSessionRequest {
    pub session_id: String,
}

/// A command to execute
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

impl Command {
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            args: None,
        }
    }

    pub fn with_args(mut self, args: Vec<String>) -> Self {
        self.args = Some(args);
        self
    }
}

/// Result of a command execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Request to read a file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadFileRequest {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}

/// Response from reading a file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadFileResponse {
    pub content: String,
    pub size: u64,
}

/// Request to write a file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteFileRequest {
    pub path: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

/// Request to upload a file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadRequest {
    pub local_path: String,
    pub remote_path: String,
}

/// Abstract runtime trait
#[async_trait]
pub trait Runtime: Send + Sync {
    /// Execute a bash command
    async fn execute_bash(&self, action: BashAction) -> Result<BashActionResult>;

    /// Interrupt the current bash command
    async fn interrupt_bash(&self) -> Result<()>;

    /// Read a file
    async fn read_file(&self, path: &str) -> Result<String>;

    /// Write a file
    async fn write_file(&self, path: &str, content: &str) -> Result<()>;

    /// Upload a file to the runtime
    async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<()>;

    /// Get current working directory
    fn get_cwd(&self) -> Option<String>;

    /// Check if runtime is alive
    fn is_alive(&self) -> bool;
}

/// Simple local runtime for testing
pub struct LocalRuntime {
    cwd: String,
    alive: bool,
}

impl LocalRuntime {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            cwd: cwd.into(),
            alive: true,
        }
    }
}

#[async_trait]
impl Runtime for LocalRuntime {
    async fn execute_bash(&self, action: BashAction) -> Result<BashActionResult> {
        use std::process::Command;

        let output = Command::new("sh")
            .arg("-c")
            .arg(&action.command)
            .current_dir(action.cwd.as_ref().unwrap_or(&self.cwd))
            .output()
            .map_err(|e| SWEAgentError::RuntimeError(e.to_string()))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(BashActionResult {
            output: if stderr.is_empty() {
                stdout
            } else {
                format!("{}\n{}", stdout, stderr)
            },
            exit_code: output.status.code().unwrap_or(-1),
            timed_out: false,
        })
    }

    async fn interrupt_bash(&self) -> Result<()> {
        // Not applicable for local runtime
        Ok(())
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        std::fs::read_to_string(path).map_err(|e| SWEAgentError::IoError(e.to_string()))
    }

    async fn write_file(&self, path: &str, content: &str) -> Result<()> {
        std::fs::write(path, content).map_err(|e| SWEAgentError::IoError(e.to_string()))
    }

    async fn upload_file(&self, local_path: &str, remote_path: &str) -> Result<()> {
        std::fs::copy(local_path, remote_path)
            .map(|_| ())
            .map_err(|e| SWEAgentError::IoError(e.to_string()))
    }

    fn get_cwd(&self) -> Option<String> {
        Some(self.cwd.clone())
    }

    fn is_alive(&self) -> bool {
        self.alive
    }
}

// Re-export
pub use LocalRuntime as AbstractRuntime;
