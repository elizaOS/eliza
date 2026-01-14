use crate::{Action, ActionExample, ActionResult, ShellService};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct ExecuteCommandAction;

impl ExecuteCommandAction {
    const COMMAND_KEYWORDS: &'static [&'static str] = &[
        "run",
        "execute",
        "command",
        "shell",
        "install",
        "brew",
        "npm",
        "create",
        "file",
        "directory",
        "folder",
        "list",
        "show",
        "system",
        "info",
        "check",
        "status",
        "cd",
        "ls",
        "mkdir",
        "echo",
        "cat",
        "touch",
        "git",
        "build",
        "test",
    ];

    /// Check if text contains command keywords.
    fn has_command_keyword(text: &str) -> bool {
        let lower = text.to_lowercase();
        Self::COMMAND_KEYWORDS.iter().any(|kw| lower.contains(kw))
    }

    /// Check if text starts with a direct command.
    fn has_direct_command(text: &str) -> bool {
        let direct_commands = [
            "brew", "npm", "apt", "git", "ls", "cd", "echo", "cat", "touch", "mkdir", "rm", "mv",
            "cp",
        ];
        let lower = text.to_lowercase();
        direct_commands.iter().any(|cmd| {
            lower.starts_with(cmd)
                && (lower.len() == cmd.len() || lower.chars().nth(cmd.len()) == Some(' '))
        })
    }
}

#[async_trait]
impl Action for ExecuteCommandAction {
    fn name(&self) -> &str {
        "EXECUTE_COMMAND"
    }

    fn similes(&self) -> Vec<&str> {
        vec![
            "RUN_COMMAND",
            "SHELL_COMMAND",
            "TERMINAL_COMMAND",
            "EXEC",
            "RUN",
            "EXECUTE",
            "CREATE_FILE",
            "WRITE_FILE",
            "MAKE_FILE",
            "INSTALL",
            "BREW_INSTALL",
            "NPM_INSTALL",
            "APT_INSTALL",
        ]
    }

    fn description(&self) -> &str {
        "Execute shell commands including brew install, npm install, apt-get, \
         system commands, file operations, directory navigation, and scripts."
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        Self::has_command_keyword(text) || Self::has_direct_command(text)
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut ShellService>,
    ) -> ActionResult {
        let service = match service {
            Some(s) => s,
            None => {
                return ActionResult {
                    success: false,
                    text: "Shell service is not available.".to_string(),
                    data: None,
                    error: Some("Shell service is not available".to_string()),
                }
            }
        };

        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let command = extract_command_from_text(text);

        if command.is_empty() {
            return ActionResult {
                success: false,
                text:
                    "Could not determine which command to execute. Please specify a shell command."
                        .to_string(),
                data: None,
                error: Some("Could not extract command".to_string()),
            };
        }

        let conversation_id = message
            .get("room_id")
            .and_then(|r| r.as_str())
            .or_else(|| message.get("agent_id").and_then(|a| a.as_str()));

        match service.execute_command(&command, conversation_id).await {
            Ok(result) => {
                let response_text = if result.success {
                    let output = if result.stdout.is_empty() {
                        "Command completed with no output.".to_string()
                    } else {
                        format!("Output:\n```\n{}\n```", result.stdout)
                    };
                    format!(
                        "Command executed successfully in {}\n\n{}",
                        result.executed_in, output
                    )
                } else {
                    let exit_code_str = result
                        .exit_code
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| String::from("unknown"));
                    let mut msg = format!(
                        "Command failed with exit code {} in {}\n\n",
                        exit_code_str, result.executed_in
                    );
                    if !result.stderr.is_empty() {
                        msg.push_str(&format!("Error output:\n```\n{}\n```", result.stderr));
                    }
                    msg
                };

                ActionResult {
                    success: result.success,
                    text: response_text,
                    data: Some(json!({
                        "command": command,
                        "exit_code": result.exit_code,
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                    })),
                    error: if result.success {
                        None
                    } else {
                        Some(result.stderr)
                    },
                }
            }
            Err(e) => ActionResult {
                success: false,
                text: format!("Failed to execute command: {}", e),
                data: None,
                error: Some(e.to_string()),
            },
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                user_message: "run ls -la".to_string(),
                agent_response: "I'll execute that command for you.".to_string(),
            },
            ActionExample {
                user_message: "show me what files are in this directory".to_string(),
                agent_response: "I'll list the files in the current directory.".to_string(),
            },
            ActionExample {
                user_message: "check the git status".to_string(),
                agent_response: "I'll check the git repository status.".to_string(),
            },
            ActionExample {
                user_message: "create a file called hello.txt".to_string(),
                agent_response: "I'll create hello.txt for you.".to_string(),
            },
        ]
    }
}

fn extract_command_from_text(text: &str) -> String {
    let lower = text.to_lowercase();

    let direct_commands = [
        "ls", "cd", "pwd", "echo", "cat", "mkdir", "rm", "mv", "cp", "git", "npm", "brew", "apt",
    ];

    for cmd in direct_commands {
        if lower.starts_with(cmd) {
            return text.to_string();
        }
        if let Some(pos) = lower.find(&format!("run {}", cmd)) {
            return text[pos + 4..].trim().to_string();
        }
        if let Some(pos) = lower.find(&format!("execute {}", cmd)) {
            return text[pos + 8..].trim().to_string();
        }
    }

    if let Some(pos) = lower.find("run ") {
        return text[pos + 4..].trim().to_string();
    }
    if let Some(pos) = lower.find("execute ") {
        return text[pos + 8..].trim().to_string();
    }

    if lower.contains("list") && (lower.contains("file") || lower.contains("director")) {
        return "ls -la".to_string();
    }
    if lower.contains("git status") || (lower.contains("check") && lower.contains("git")) {
        return "git status".to_string();
    }
    if lower.contains("current director") || lower.contains("where am i") {
        return "pwd".to_string();
    }

    String::new()
}
