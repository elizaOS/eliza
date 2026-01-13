#![allow(missing_docs)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::info;

use crate::error::Result;
use crate::path_utils::{is_forbidden_command, is_safe_command, validate_path};
use crate::types::{
    CommandHistoryEntry, CommandResult, FileOperation, FileOperationType, ShellConfig,
};

pub struct ShellService {
    config: ShellConfig,
    current_directory: PathBuf,
    command_history: HashMap<String, Vec<CommandHistoryEntry>>,
    max_history_per_conversation: usize,
}

impl ShellService {
    pub fn new(config: ShellConfig) -> Self {
        let current_directory = config.allowed_directory.clone();
        info!("Shell service initialized with history tracking");

        Self {
            config,
            current_directory,
            command_history: HashMap::new(),
            max_history_per_conversation: 100,
        }
    }

    pub fn current_directory(&self) -> &Path {
        &self.current_directory
    }

    pub fn allowed_directory(&self) -> &Path {
        &self.config.allowed_directory
    }

    pub async fn execute_command(
        &mut self,
        command: &str,
        conversation_id: Option<&str>,
    ) -> Result<CommandResult> {
        if !self.config.enabled {
            return Ok(CommandResult::error(
                "Shell plugin disabled",
                "Shell plugin is disabled. Set SHELL_ENABLED=true to enable.",
                &self.current_directory.display().to_string(),
            ));
        }

        let trimmed_command = command.trim();
        if trimmed_command.is_empty() {
            return Ok(CommandResult::error(
                "Invalid command",
                "Command must be a non-empty string",
                &self.current_directory.display().to_string(),
            ));
        }

        if !is_safe_command(trimmed_command) {
            return Ok(CommandResult::error(
                "Security policy violation",
                "Command contains forbidden patterns",
                &self.current_directory.display().to_string(),
            ));
        }

        if is_forbidden_command(trimmed_command, &self.config.forbidden_commands) {
            return Ok(CommandResult::error(
                "Forbidden command",
                "Command is forbidden by security policy",
                &self.current_directory.display().to_string(),
            ));
        }

        if trimmed_command.starts_with("cd ") {
            let result = self.handle_cd_command(trimmed_command);
            if let Some(conv_id) = conversation_id {
                self.add_to_history(conv_id, trimmed_command, &result, None);
            }
            return Ok(result);
        }

        let result = self.run_command(trimmed_command).await?;

        if let Some(conv_id) = conversation_id {
            let file_ops = if result.success {
                self.detect_file_operations(trimmed_command)
            } else {
                None
            };
            self.add_to_history(conv_id, trimmed_command, &result, file_ops);
        }

        Ok(result)
    }

    fn handle_cd_command(&mut self, command: &str) -> CommandResult {
        let parts: Vec<&str> = command.split_whitespace().collect();

        if parts.len() < 2 {
            self.current_directory = self.config.allowed_directory.clone();
            return CommandResult::success(
                format!("Changed directory to: {}", self.current_directory.display()),
                &self.current_directory.display().to_string(),
            );
        }

        let target_path = parts[1..].join(" ");
        let validated = validate_path(
            &target_path,
            &self.config.allowed_directory,
            &self.current_directory,
        );

        match validated {
            Some(path) => {
                self.current_directory = path;
                CommandResult::success(
                    format!("Changed directory to: {}", self.current_directory.display()),
                    &self.current_directory.display().to_string(),
                )
            }
            None => CommandResult::error(
                "Permission denied",
                "Cannot navigate outside allowed directory",
                &self.current_directory.display().to_string(),
            ),
        }
    }

    /// Run a command using tokio process.
    async fn run_command(&self, command: &str) -> Result<CommandResult> {
        let cwd = self.current_directory.display().to_string();
        let use_shell = command.contains('>') || command.contains('<') || command.contains('|');

        let mut cmd = if use_shell {
            info!("Executing shell command: sh -c \"{}\" in {}", command, cwd);
            let mut c = Command::new("sh");
            c.args(["-c", command]);
            c
        } else {
            let parts: Vec<&str> = command.split_whitespace().collect();
            if parts.is_empty() {
                return Ok(CommandResult::error(
                    "Invalid command",
                    "Empty command",
                    &cwd,
                ));
            }
            info!("Executing command: {} in {}", command, cwd);
            let mut c = Command::new(parts[0]);
            if parts.len() > 1 {
                c.args(&parts[1..]);
            }
            c
        };

        cmd.current_dir(&self.current_directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let timeout_duration = Duration::from_millis(self.config.timeout_ms);
        let spawn_result = cmd.spawn();

        match spawn_result {
            Ok(mut child) => {
                let stdout_handle = child.stdout.take();
                let stderr_handle = child.stderr.take();

                match timeout(timeout_duration, child.wait()).await {
                    Ok(Ok(status)) => {
                        let mut stdout = String::new();
                        let mut stderr = String::new();

                        if let Some(mut handle) = stdout_handle {
                            let _ = handle.read_to_string(&mut stdout).await;
                        }
                        if let Some(mut handle) = stderr_handle {
                            let _ = handle.read_to_string(&mut stderr).await;
                        }

                        Ok(CommandResult {
                            success: status.success(),
                            stdout,
                            stderr,
                            exit_code: status.code(),
                            error: None,
                            executed_in: cwd,
                        })
                    }
                    Ok(Err(e)) => Ok(CommandResult::error(
                        "Failed to execute command",
                        &e.to_string(),
                        &cwd,
                    )),
                    Err(_) => {
                        let _ = child.kill().await;
                        Ok(CommandResult {
                            success: false,
                            stdout: String::new(),
                            stderr: "Command timed out".to_string(),
                            exit_code: None,
                            error: Some("Command execution timeout".to_string()),
                            executed_in: cwd,
                        })
                    }
                }
            }
            Err(e) => Ok(CommandResult::error(
                "Failed to execute command",
                &e.to_string(),
                &cwd,
            )),
        }
    }

    fn add_to_history(
        &mut self,
        conversation_id: &str,
        command: &str,
        result: &CommandResult,
        file_operations: Option<Vec<FileOperation>>,
    ) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);

        let entry = CommandHistoryEntry {
            command: command.to_string(),
            stdout: result.stdout.clone(),
            stderr: result.stderr.clone(),
            exit_code: result.exit_code,
            timestamp,
            working_directory: result.executed_in.clone(),
            file_operations,
        };

        let history = self
            .command_history
            .entry(conversation_id.to_string())
            .or_default();

        history.push(entry);

        if history.len() > self.max_history_per_conversation {
            history.remove(0);
        }
    }

    fn detect_file_operations(&self, command: &str) -> Option<Vec<FileOperation>> {
        let parts: Vec<&str> = command.split_whitespace().collect();
        if parts.is_empty() {
            return None;
        }

        let cmd = parts[0].to_lowercase();
        let cwd = &self.current_directory;
        let mut operations = Vec::new();

        let resolve_path = |path: &str| -> String {
            if Path::new(path).is_absolute() {
                path.to_string()
            } else {
                cwd.join(path).display().to_string()
            }
        };

        match cmd.as_str() {
            "touch" if parts.len() > 1 => {
                operations.push(FileOperation {
                    op_type: FileOperationType::Create,
                    target: resolve_path(parts[1]),
                    secondary_target: None,
                });
            }
            "echo" if command.contains('>') => {
                if let Some(pos) = command.rfind('>') {
                    let target = command[pos + 1..].trim();
                    if !target.is_empty() {
                        let target = target.split_whitespace().next().unwrap_or(target);
                        operations.push(FileOperation {
                            op_type: FileOperationType::Write,
                            target: resolve_path(target),
                            secondary_target: None,
                        });
                    }
                }
            }
            "mkdir" if parts.len() > 1 => {
                operations.push(FileOperation {
                    op_type: FileOperationType::Mkdir,
                    target: resolve_path(parts[1]),
                    secondary_target: None,
                });
            }
            "cat" if parts.len() > 1 && !command.contains('>') => {
                operations.push(FileOperation {
                    op_type: FileOperationType::Read,
                    target: resolve_path(parts[1]),
                    secondary_target: None,
                });
            }
            "mv" if parts.len() > 2 => {
                operations.push(FileOperation {
                    op_type: FileOperationType::Move,
                    target: resolve_path(parts[1]),
                    secondary_target: Some(resolve_path(parts[2])),
                });
            }
            "cp" if parts.len() > 2 => {
                operations.push(FileOperation {
                    op_type: FileOperationType::Copy,
                    target: resolve_path(parts[1]),
                    secondary_target: Some(resolve_path(parts[2])),
                });
            }
            _ => {}
        }

        if operations.is_empty() {
            None
        } else {
            Some(operations)
        }
    }

    pub fn get_command_history(
        &self,
        conversation_id: &str,
        limit: Option<usize>,
    ) -> Vec<CommandHistoryEntry> {
        let history = self
            .command_history
            .get(conversation_id)
            .cloned()
            .unwrap_or_default();

        match limit {
            Some(n) if n > 0 => history.into_iter().rev().take(n).rev().collect(),
            _ => history,
        }
    }

    pub fn clear_command_history(&mut self, conversation_id: &str) {
        self.command_history.remove(conversation_id);
        info!(
            "Cleared command history for conversation: {}",
            conversation_id
        );
    }

    pub fn get_current_directory(&self, _conversation_id: Option<&str>) -> &Path {
        &self.current_directory
    }

    pub fn get_allowed_directory(&self) -> &Path {
        &self.config.allowed_directory
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_config() -> ShellConfig {
        let dir = tempdir().unwrap();
        ShellConfig {
            enabled: true,
            allowed_directory: dir.keep(),
            timeout_ms: 30000,
            forbidden_commands: vec!["rm".to_string(), "rmdir".to_string()],
        }
    }

    #[tokio::test]
    async fn test_disabled_shell() {
        let mut config = test_config();
        config.enabled = false;
        let mut service = ShellService::new(config);

        let result = service.execute_command("ls", None).await.unwrap();
        assert!(!result.success);
        assert!(result.stderr.contains("disabled"));
    }

    #[tokio::test]
    async fn test_forbidden_command() {
        let config = test_config();
        let mut service = ShellService::new(config);

        let result = service.execute_command("rm file.txt", None).await.unwrap();
        assert!(!result.success);
        assert!(result.stderr.contains("forbidden"));
    }

    #[tokio::test]
    async fn test_history_tracking() {
        let config = test_config();
        let mut service = ShellService::new(config);
        let conv_id = "test-conv";

        service
            .execute_command("echo hello", Some(conv_id))
            .await
            .unwrap();

        let history = service.get_command_history(conv_id, None);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].command, "echo hello");
    }

    #[tokio::test]
    async fn test_clear_history() {
        let config = test_config();
        let mut service = ShellService::new(config);
        let conv_id = "test-conv";

        service
            .execute_command("echo test", Some(conv_id))
            .await
            .unwrap();
        assert_eq!(service.get_command_history(conv_id, None).len(), 1);

        service.clear_command_history(conv_id);
        assert_eq!(service.get_command_history(conv_id, None).len(), 0);
    }
}
