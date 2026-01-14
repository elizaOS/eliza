use crate::{Provider, ProviderResult, ShellService};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::{Duration, UNIX_EPOCH};

const MAX_OUTPUT_LENGTH: usize = 8000;
const TRUNCATE_SEGMENT_LENGTH: usize = 4000;

pub struct ShellHistoryProvider;

fn format_timestamp(timestamp: f64) -> String {
    let duration = Duration::from_secs_f64(timestamp);
    let _datetime = UNIX_EPOCH + duration;
    // Format as simple ISO-like string
    format!("{:.0}", timestamp)
}

#[async_trait]
impl Provider for ShellHistoryProvider {
    fn name(&self) -> &str {
        "SHELL_HISTORY"
    }

    fn description(&self) -> &str {
        "Provides recent shell command history, current working directory, \
         and file operations within the restricted environment"
    }

    fn position(&self) -> i32 {
        99
    }

    async fn get(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&ShellService>,
    ) -> ProviderResult {
        let service = match service {
            Some(s) => s,
            None => {
                return ProviderResult {
                    values: json!({
                        "shellHistory": "Shell service is not available",
                        "currentWorkingDirectory": "N/A",
                        "allowedDirectory": "N/A",
                    }),
                    text: "# Shell Status\n\nShell service is not available".to_string(),
                    data: json!({
                        "historyCount": 0,
                        "cwd": "N/A",
                        "allowedDir": "N/A",
                    }),
                };
            }
        };

        let conversation_id = message
            .get("room_id")
            .and_then(|r| r.as_str())
            .or_else(|| message.get("agent_id").and_then(|a| a.as_str()))
            .unwrap_or("default");

        let history = service.get_command_history(conversation_id, Some(10));
        let cwd = service.get_current_directory(None);
        let allowed_dir = service.get_allowed_directory();

        let history_text = if history.is_empty() {
            "No commands in history.".to_string()
        } else {
            history
                .iter()
                .map(|entry| {
                    let mut entry_str = format!(
                        "[{}] {}> {}",
                        format_timestamp(entry.timestamp),
                        entry.working_directory,
                        entry.command
                    );

                    if !entry.stdout.is_empty() {
                        let stdout = if entry.stdout.len() > MAX_OUTPUT_LENGTH {
                            format!(
                                "{}\n  ... [TRUNCATED] ...\n  {}",
                                &entry.stdout[..TRUNCATE_SEGMENT_LENGTH],
                                &entry.stdout[entry.stdout.len() - TRUNCATE_SEGMENT_LENGTH..]
                            )
                        } else {
                            entry.stdout.clone()
                        };
                        entry_str.push_str(&format!("\n  Output: {}", stdout));
                    }

                    if !entry.stderr.is_empty() {
                        let stderr = if entry.stderr.len() > MAX_OUTPUT_LENGTH {
                            format!(
                                "{}\n  ... [TRUNCATED] ...\n  {}",
                                &entry.stderr[..TRUNCATE_SEGMENT_LENGTH],
                                &entry.stderr[entry.stderr.len() - TRUNCATE_SEGMENT_LENGTH..]
                            )
                        } else {
                            entry.stderr.clone()
                        };
                        entry_str.push_str(&format!("\n  Error: {}", stderr));
                    }

                    if let Some(exit_code) = entry.exit_code {
                        entry_str.push_str(&format!("\n  Exit Code: {}", exit_code));
                    }

                    if let Some(ref file_ops) = entry.file_operations {
                        if !file_ops.is_empty() {
                            entry_str.push_str("\n  File Operations:");
                            for op in file_ops {
                                if let Some(ref secondary) = op.secondary_target {
                                    entry_str.push_str(&format!(
                                        "\n    - {:?}: {} → {}",
                                        op.op_type, op.target, secondary
                                    ));
                                } else {
                                    entry_str.push_str(&format!(
                                        "\n    - {:?}: {}",
                                        op.op_type, op.target
                                    ));
                                }
                            }
                        }
                    }

                    entry_str
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        };

        let recent_file_ops: Vec<_> = history
            .iter()
            .filter_map(|e| e.file_operations.as_ref())
            .flat_map(|ops| ops.iter())
            .take(5)
            .collect();

        let file_ops_text = if recent_file_ops.is_empty() {
            String::new()
        } else {
            let ops_str = recent_file_ops
                .iter()
                .map(|op| {
                    if let Some(ref secondary) = op.secondary_target {
                        format!("- {:?}: {} → {}", op.op_type, op.target, secondary)
                    } else {
                        format!("- {:?}: {}", op.op_type, op.target)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("\n\n# Recent File Operations\n\n{}", ops_str)
        };

        let cwd_str = cwd.display().to_string();
        let allowed_dir_str = allowed_dir.display().to_string();

        let text = format!(
            "Current Directory: {}\nAllowed Directory: {}\n\n# Shell History (Last 10)\n\n{}{}",
            cwd_str, allowed_dir_str, history_text, file_ops_text
        );

        ProviderResult {
            values: json!({
                "shellHistory": history_text,
                "currentWorkingDirectory": cwd_str,
                "allowedDirectory": allowed_dir_str,
            }),
            text,
            data: json!({
                "historyCount": history.len(),
                "cwd": cwd_str,
                "allowedDir": allowed_dir_str,
            }),
        }
    }
}
