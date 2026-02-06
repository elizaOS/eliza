//! Lobster service for subprocess execution

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::info;

use crate::error::{LobsterError, Result};
use crate::types::{LobsterApprovalRequest, LobsterConfig, LobsterResult};

/// Resolve the lobster executable path
fn resolve_executable_path(configured_path: Option<&str>) -> Result<String> {
    if let Some(path) = configured_path {
        // Security: ensure it's actually called "lobster"
        let base = Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if base != "lobster" && base != "lobster.exe" {
            return Err(LobsterError::InvalidPath(path.to_string()));
        }
        return Ok(path.to_string());
    }

    // Try to find in PATH using `which`
    if let Ok(output) = std::process::Command::new("which")
        .arg("lobster")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Ok(path);
            }
        }
    }

    Ok("lobster".to_string())
}

/// Normalize and validate working directory
fn normalize_cwd(cwd: Option<&str>, allowed_base: Option<&str>) -> Result<String> {
    let resolved = match cwd {
        Some(path) => std::fs::canonicalize(path)
            .map_err(|_| LobsterError::InvalidPath(path.to_string()))?
            .display()
            .to_string(),
        None => std::env::current_dir()
            .map_err(|e| LobsterError::IoError(e))?
            .display()
            .to_string(),
    };

    if let Some(base) = allowed_base {
        let allowed_resolved = std::fs::canonicalize(base)
            .map_err(|_| LobsterError::InvalidPath(base.to_string()))?
            .display()
            .to_string();

        if !resolved.starts_with(&allowed_resolved) {
            return Err(LobsterError::SandboxEscape(resolved));
        }
    }

    Ok(resolved)
}

/// Service for running Lobster pipelines
pub struct LobsterService {
    config: LobsterConfig,
    executable: String,
}

impl LobsterService {
    /// Create a new LobsterService with the given configuration
    pub fn new(config: LobsterConfig) -> Result<Self> {
        let executable = resolve_executable_path(Some(&config.lobster_path))?;
        info!("Lobster service initialized with executable: {}", executable);

        Ok(Self { config, executable })
    }

    /// Create a new LobsterService with default configuration
    pub fn with_defaults() -> Result<Self> {
        let config = LobsterConfig::default();
        let executable = resolve_executable_path(None)?;
        info!("Lobster service initialized with executable: {}", executable);

        Ok(Self { config, executable })
    }

    /// Get timeout duration
    fn timeout_duration(&self) -> Duration {
        Duration::from_millis(self.config.timeout_ms)
    }

    /// Check if lobster is available
    pub async fn is_available(&self) -> bool {
        match Command::new(&self.executable)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => {
                match timeout(Duration::from_secs(5), child.wait_with_output()).await {
                    Ok(Ok(output)) => output.status.success(),
                    _ => false,
                }
            }
            Err(_) => false,
        }
    }

    /// Run a Lobster pipeline
    pub async fn run(
        &self,
        pipeline: &str,
        args: Option<HashMap<String, serde_json::Value>>,
        cwd: Option<&str>,
    ) -> LobsterResult {
        let working_dir = match normalize_cwd(cwd, None) {
            Ok(dir) => dir,
            Err(e) => return LobsterResult::error(e.to_string()),
        };

        let mut cmd_args = vec![self.executable.clone(), "run".to_string(), pipeline.to_string()];

        if let Some(args) = args {
            if let Ok(json) = serde_json::to_string(&args) {
                cmd_args.push("--args".to_string());
                cmd_args.push(json);
            }
        }

        self.execute(&cmd_args, &working_dir).await
    }

    /// Resume a paused Lobster pipeline
    pub async fn resume(&self, token: &str, approve: bool) -> LobsterResult {
        let action = if approve { "approve" } else { "reject" };
        let cmd_args = vec![
            self.executable.clone(),
            "resume".to_string(),
            token.to_string(),
            "--action".to_string(),
            action.to_string(),
        ];

        let cwd = std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| ".".to_string());

        self.execute(&cmd_args, &cwd).await
    }

    /// Execute a lobster command and parse the result
    async fn execute(&self, cmd_args: &[String], cwd: &str) -> LobsterResult {
        info!("Executing: {} in {}", cmd_args.join(" "), cwd);

        let mut cmd = Command::new(&cmd_args[0]);
        if cmd_args.len() > 1 {
            cmd.args(&cmd_args[1..]);
        }

        cmd.current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return LobsterResult::error(format!(
                        "Lobster executable not found: {}",
                        self.executable
                    ));
                }
                return LobsterResult::error(format!("Failed to spawn process: {}", e));
            }
        };

        let output = match timeout(self.timeout_duration(), child.wait_with_output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => return LobsterResult::error(format!("Process error: {}", e)),
            Err(_) => return LobsterResult::error("Lobster command timed out"),
        };

        let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        // Truncate if too large
        if stdout.len() > self.config.max_stdout_bytes {
            stdout.truncate(self.config.max_stdout_bytes);
            stdout.push_str("\n... (truncated)");
        }

        if !output.status.success() {
            return LobsterResult::error(if stderr.is_empty() {
                format!("Lobster exited with code {:?}", output.status.code())
            } else {
                stderr
            });
        }

        self.parse_envelope(&stdout)
    }

    /// Parse the JSON envelope from lobster output
    fn parse_envelope(&self, stdout: &str) -> LobsterResult {
        // Find the JSON envelope (should be the last line)
        let json_line = stdout
            .lines()
            .rev()
            .find(|line| line.trim().starts_with('{'));

        let Some(json_str) = json_line else {
            return LobsterResult::error("No JSON envelope found in lobster output");
        };

        let envelope: serde_json::Value = match serde_json::from_str(json_str) {
            Ok(v) => v,
            Err(e) => return LobsterResult::error(format!("Failed to parse output: {}", e)),
        };

        let status = envelope
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        match status {
            "error" => {
                let error = envelope
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error");
                LobsterResult::error(error)
            }
            "needs_approval" => {
                if let Some(approval) = envelope.get("approval") {
                    let req = LobsterApprovalRequest {
                        step_name: approval
                            .get("step_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        description: approval
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        resume_token: approval
                            .get("resume_token")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    };
                    LobsterResult::needs_approval(req)
                } else {
                    LobsterResult::error("Missing approval data")
                }
            }
            "success" => {
                let outputs = envelope
                    .get("outputs")
                    .and_then(|v| serde_json::from_value(v.clone()).ok());
                LobsterResult::success(outputs)
            }
            _ => LobsterResult::error(format!("Unknown status: {}", status)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_executable_path_default() {
        let path = resolve_executable_path(None).unwrap();
        assert!(!path.is_empty());
    }

    #[test]
    fn test_resolve_executable_path_invalid() {
        let result = resolve_executable_path(Some("/usr/bin/malicious"));
        assert!(result.is_err());
    }

    #[test]
    fn test_resolve_executable_path_valid() {
        let result = resolve_executable_path(Some("/usr/bin/lobster"));
        assert!(result.is_ok());
    }

    #[test]
    fn test_lobster_result_success() {
        let result = LobsterResult::success(None);
        assert!(result.success);
        assert_eq!(result.status, "success");
    }

    #[test]
    fn test_lobster_result_error() {
        let result = LobsterResult::error("test error");
        assert!(!result.success);
        assert_eq!(result.error, Some("test error".to_string()));
    }
}
