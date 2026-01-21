use async_trait::async_trait;
use serde_json::{json, Value};

use crate::service::CoderService;
use crate::{Provider, ProviderResult};

pub struct CoderStatusProvider;

#[async_trait]
impl Provider for CoderStatusProvider {
    fn name(&self) -> &str {
        "CODER_STATUS"
    }

    fn description(&self) -> &str {
        "Provides current working directory, allowed directory, and recent command history"
    }

    fn position(&self) -> i32 {
        99
    }

    async fn get(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&CoderService>,
    ) -> ProviderResult {
        let Some(svc) = service else {
            return ProviderResult {
                values: json!({
                    "coderStatus": "Coder service is not available",
                    "currentWorkingDirectory": "N/A",
                    "allowedDirectory": "N/A"
                }),
                text: "# Coder Status\n\nCoder service is not available".to_string(),
                data: json!({ "historyCount": 0, "cwd": "N/A", "allowedDir": "N/A" }),
            };
        };

        let conv = message
            .get("room_id")
            .and_then(|v| v.as_str())
            .or_else(|| message.get("agent_id").and_then(|v| v.as_str()))
            .unwrap_or("default");

        let cwd = svc.current_directory(conv).display().to_string();
        let allowed = svc.allowed_directory().display().to_string();
        let history = svc.get_command_history(conv, Some(10));

        let history_text = if history.is_empty() {
            "No commands in history.".to_string()
        } else {
            history
                .iter()
                .map(|h| format!("{}> {}", h.working_directory, h.command))
                .collect::<Vec<String>>()
                .join("\n")
        };

        ProviderResult {
            values: json!({
                "coderStatus": history_text,
                "currentWorkingDirectory": cwd,
                "allowedDirectory": allowed
            }),
            text: format!(
                "Current Directory: {}\nAllowed Directory: {}\n\n{}",
                svc.current_directory(conv).display(),
                svc.allowed_directory().display(),
                history_text
            ),
            data: json!({
                "historyCount": history.len(),
                "cwd": svc.current_directory(conv).display().to_string(),
                "allowedDir": svc.allowed_directory().display().to_string()
            }),
        }
    }
}
