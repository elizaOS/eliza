use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::info;

use crate::error::Result;
use crate::path_utils::{is_forbidden_command, is_safe_command, validate_path};
use crate::types::{
    CodeConfig, CommandHistoryEntry, CommandResult, FileOperation, FileOperationType,
};

pub struct CoderService {
    config: CodeConfig,
    cwd_by_conversation: HashMap<String, PathBuf>,
    history_by_conversation: HashMap<String, Vec<CommandHistoryEntry>>,
    max_history_per_conversation: usize,
}

impl CoderService {
    pub fn new(config: CodeConfig) -> Self {
        info!("Coder service initialized");
        Self {
            cwd_by_conversation: HashMap::new(),
            history_by_conversation: HashMap::new(),
            config,
            max_history_per_conversation: 100,
        }
    }

    pub fn allowed_directory(&self) -> &Path {
        &self.config.allowed_directory
    }

    pub fn current_directory(&self, conversation_id: &str) -> PathBuf {
        self.cwd_by_conversation
            .get(conversation_id)
            .cloned()
            .unwrap_or_else(|| self.config.allowed_directory.clone())
    }

    pub fn get_command_history(
        &self,
        conversation_id: &str,
        limit: Option<usize>,
    ) -> Vec<CommandHistoryEntry> {
        let all = self
            .history_by_conversation
            .get(conversation_id)
            .cloned()
            .unwrap_or_default();
        match limit {
            None => all,
            Some(l) => {
                if l == 0 {
                    vec![]
                } else if all.len() <= l {
                    all
                } else {
                    all[all.len() - l..].to_vec()
                }
            }
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_else(|_| Duration::from_millis(0))
            .as_millis() as u64
    }

    fn ensure_enabled(&self) -> Option<String> {
        if self.config.enabled {
            None
        } else {
            Some("Coder plugin is disabled. Set CODER_ENABLED=true to enable.".to_string())
        }
    }

    fn add_history(
        &mut self,
        conversation_id: &str,
        command: &str,
        result: &CommandResult,
        file_ops: Option<Vec<FileOperation>>,
    ) {
        let list = self
            .history_by_conversation
            .entry(conversation_id.to_string())
            .or_default();

        list.push(CommandHistoryEntry {
            timestamp_ms: Self::now_ms(),
            working_directory: result.executed_in.clone(),
            command: command.to_string(),
            stdout: result.stdout.clone(),
            stderr: result.stderr.clone(),
            exit_code: result.exit_code,
            file_operations: file_ops,
        });

        if list.len() > self.max_history_per_conversation {
            let start = list.len() - self.max_history_per_conversation;
            *list = list[start..].to_vec();
        }
    }

    fn resolve_within(&self, conversation_id: &str, target: &str) -> Option<PathBuf> {
        let cwd = self.current_directory(conversation_id);
        validate_path(target, &self.config.allowed_directory, &cwd)
    }

    pub async fn change_directory(&mut self, conversation_id: &str, target: &str) -> CommandResult {
        if let Some(msg) = self.ensure_enabled() {
            return CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: msg,
                exit_code: Some(1),
                error: Some("Coder disabled".to_string()),
                executed_in: self
                    .current_directory(conversation_id)
                    .display()
                    .to_string(),
            };
        }

        let resolved = match self.resolve_within(conversation_id, target) {
            Some(p) => p,
            None => {
                return CommandResult {
                    success: false,
                    stdout: "".to_string(),
                    stderr: "Cannot navigate outside allowed directory".to_string(),
                    exit_code: Some(1),
                    error: Some("Permission denied".to_string()),
                    executed_in: self
                        .current_directory(conversation_id)
                        .display()
                        .to_string(),
                }
            }
        };

        let meta = fs::metadata(&resolved).await;
        let is_dir = meta.map(|m| m.is_dir()).unwrap_or(false);
        if !is_dir {
            return CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: "Not a directory".to_string(),
                exit_code: Some(1),
                error: Some("Not a directory".to_string()),
                executed_in: self
                    .current_directory(conversation_id)
                    .display()
                    .to_string(),
            };
        }

        self.cwd_by_conversation
            .insert(conversation_id.to_string(), resolved.clone());

        CommandResult {
            success: true,
            stdout: format!("Changed directory to: {}", resolved.display()),
            stderr: "".to_string(),
            exit_code: Some(0),
            error: None,
            executed_in: resolved.display().to_string(),
        }
    }

    pub async fn read_file(
        &self,
        conversation_id: &str,
        filepath: &str,
    ) -> std::result::Result<String, String> {
        if let Some(msg) = self.ensure_enabled() {
            return Err(msg);
        }
        let resolved = self
            .resolve_within(conversation_id, filepath)
            .ok_or_else(|| "Cannot access path outside allowed directory".to_string())?;
        let meta = fs::metadata(&resolved).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "File not found".to_string()
            } else {
                e.to_string()
            }
        })?;
        if meta.is_dir() {
            return Err("Path is a directory".to_string());
        }
        fs::read_to_string(&resolved)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn write_file(
        &self,
        conversation_id: &str,
        filepath: &str,
        content: &str,
    ) -> std::result::Result<(), String> {
        if let Some(msg) = self.ensure_enabled() {
            return Err(msg);
        }
        let resolved = self
            .resolve_within(conversation_id, filepath)
            .ok_or_else(|| "Cannot access path outside allowed directory".to_string())?;
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        fs::write(&resolved, content)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn edit_file(
        &self,
        conversation_id: &str,
        filepath: &str,
        old_str: &str,
        new_str: &str,
    ) -> std::result::Result<(), String> {
        if let Some(msg) = self.ensure_enabled() {
            return Err(msg);
        }
        let resolved = self
            .resolve_within(conversation_id, filepath)
            .ok_or_else(|| "Cannot access path outside allowed directory".to_string())?;
        let content = fs::read_to_string(&resolved).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "File not found".to_string()
            } else {
                e.to_string()
            }
        })?;
        if !content.contains(old_str) {
            return Err("Could not find old_str in file".to_string());
        }
        let next = content.replacen(old_str, new_str, 1);
        fs::write(&resolved, next).await.map_err(|e| e.to_string())
    }

    pub async fn list_files(
        &self,
        conversation_id: &str,
        dirpath: &str,
    ) -> std::result::Result<Vec<String>, String> {
        if let Some(msg) = self.ensure_enabled() {
            return Err(msg);
        }
        let resolved = self
            .resolve_within(conversation_id, dirpath)
            .ok_or_else(|| "Cannot access path outside allowed directory".to_string())?;
        let mut entries = fs::read_dir(&resolved).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "Directory not found".to_string()
            } else {
                e.to_string()
            }
        })?;
        let mut items: Vec<String> = vec![];
        while let Some(e) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let meta = e.metadata().await.map_err(|e| e.to_string())?;
            items.push(if meta.is_dir() {
                format!("{}/", name)
            } else {
                name
            });
        }
        items.sort();
        Ok(items)
    }

    pub async fn search_files(
        &self,
        conversation_id: &str,
        pattern: &str,
        dirpath: &str,
        max_matches: usize,
    ) -> std::result::Result<Vec<(String, usize, String)>, String> {
        if let Some(msg) = self.ensure_enabled() {
            return Err(msg);
        }
        let needle = pattern.trim();
        if needle.is_empty() {
            return Err("Missing pattern".to_string());
        }
        let resolved = self
            .resolve_within(conversation_id, dirpath)
            .ok_or_else(|| "Cannot access path outside allowed directory".to_string())?;
        let limit = if max_matches == 0 {
            50
        } else {
            max_matches.min(500)
        };
        let mut matches: Vec<(String, usize, String)> = vec![];
        self.search_dir(&resolved, needle.to_lowercase(), &mut matches, limit)
            .await
            .map_err(|e| e.to_string())?;
        Ok(matches)
    }

    async fn search_dir(
        &self,
        dir: &Path,
        needle_lower: String,
        matches: &mut Vec<(String, usize, String)>,
        limit: usize,
    ) -> Result<()> {
        if matches.len() >= limit {
            return Ok(());
        }

        let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];

        while let Some(current) = stack.pop() {
            if matches.len() >= limit {
                break;
            }

            let mut entries = match fs::read_dir(&current).await {
                Ok(e) => e,
                Err(_) => continue,
            };

            while let Some(entry) = entries.next_entry().await? {
                if matches.len() >= limit {
                    break;
                }

                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }

                let p = entry.path();
                let meta = entry.metadata().await?;

                if meta.is_dir() {
                    if name == "node_modules"
                        || name == "dist"
                        || name == "build"
                        || name == "coverage"
                        || name == ".git"
                    {
                        continue;
                    }
                    stack.push(p);
                    continue;
                }

                if !meta.is_file() {
                    continue;
                }

                let mut f = fs::File::open(&p).await?;
                let mut content = String::new();
                let _ = f.read_to_string(&mut content).await;
                for (i, line) in content.lines().enumerate() {
                    if matches.len() >= limit {
                        break;
                    }
                    if line.to_lowercase().contains(&needle_lower) {
                        let rel = p
                            .strip_prefix(&self.config.allowed_directory)
                            .unwrap_or(&p)
                            .display()
                            .to_string();
                        matches.push((rel, i + 1, line.trim().chars().take(240).collect()));
                    }
                }
            }
        }

        Ok(())
    }

    pub async fn execute_shell(
        &mut self,
        conversation_id: &str,
        command: &str,
    ) -> Result<CommandResult> {
        if let Some(msg) = self.ensure_enabled() {
            return Ok(CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: msg,
                exit_code: Some(1),
                error: Some("Coder disabled".to_string()),
                executed_in: self
                    .current_directory(conversation_id)
                    .display()
                    .to_string(),
            });
        }

        let trimmed = command.trim();
        if trimmed.is_empty() {
            return Ok(CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: "Invalid command".to_string(),
                exit_code: Some(1),
                error: Some("Empty command".to_string()),
                executed_in: self
                    .current_directory(conversation_id)
                    .display()
                    .to_string(),
            });
        }

        if !is_safe_command(trimmed) {
            return Ok(CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: "Command contains forbidden patterns".to_string(),
                exit_code: Some(1),
                error: Some("Security policy violation".to_string()),
                executed_in: self
                    .current_directory(conversation_id)
                    .display()
                    .to_string(),
            });
        }

        if is_forbidden_command(trimmed, &self.config.forbidden_commands) {
            return Ok(CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: "Command is forbidden by security policy".to_string(),
                exit_code: Some(1),
                error: Some("Forbidden command".to_string()),
                executed_in: self
                    .current_directory(conversation_id)
                    .display()
                    .to_string(),
            });
        }

        let cwd = self.current_directory(conversation_id);
        let cwd_str = cwd.display().to_string();

        let use_shell = trimmed.contains('>') || trimmed.contains('<') || trimmed.contains('|');
        let mut cmd = if use_shell {
            let mut c = Command::new("sh");
            c.args(["-c", trimmed]);
            c
        } else {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            let mut c = Command::new(parts[0]);
            if parts.len() > 1 {
                c.args(&parts[1..]);
            }
            c
        };

        cmd.current_dir(&cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let timeout_duration = Duration::from_millis(self.config.timeout_ms);
        let spawn = cmd
            .spawn()
            .map_err(|e| crate::error::CodeError::Process(e.to_string()))?;

        let output = timeout(timeout_duration, spawn.wait_with_output()).await;

        let result = match output {
            Ok(Ok(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                CommandResult {
                    success: out.status.success(),
                    stdout,
                    stderr,
                    exit_code: out.status.code(),
                    error: None,
                    executed_in: cwd_str.clone(),
                }
            }
            Ok(Err(e)) => CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: e.to_string(),
                exit_code: Some(1),
                error: Some("Command failed".to_string()),
                executed_in: cwd_str.clone(),
            },
            Err(_) => CommandResult {
                success: false,
                stdout: "".to_string(),
                stderr: "Command timed out".to_string(),
                exit_code: None,
                error: Some("Command execution timeout".to_string()),
                executed_in: cwd_str.clone(),
            },
        };

        self.add_history(conversation_id, trimmed, &result, None);
        Ok(result)
    }

    pub async fn git(&mut self, conversation_id: &str, args: &str) -> Result<CommandResult> {
        self.execute_shell(conversation_id, &format!("git {}", args))
            .await
    }

    pub fn note_file_op(
        &mut self,
        conversation_id: &str,
        op_type: FileOperationType,
        target: &str,
    ) {
        let cwd = self
            .current_directory(conversation_id)
            .display()
            .to_string();
        let entry = CommandResult {
            success: true,
            stdout: "".to_string(),
            stderr: "".to_string(),
            exit_code: Some(0),
            error: None,
            executed_in: cwd,
        };
        self.add_history(
            conversation_id,
            "<file_op>",
            &entry,
            Some(vec![FileOperation {
                r#type: op_type,
                target: target.to_string(),
            }]),
        );
    }
}
