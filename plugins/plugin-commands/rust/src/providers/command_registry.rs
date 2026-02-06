use async_trait::async_trait;
use serde_json::{json, Value};

use crate::parser::is_command;
use crate::registry::CommandRegistry;
use crate::{Provider, ProviderResult};

/// Provider that exposes available commands to the LLM context.
///
/// When the message looks like a command, injects the full command list.
/// For normal messages, returns a minimal stub to reduce prompt noise.
pub struct CommandRegistryProvider;

#[async_trait]
impl Provider for CommandRegistryProvider {
    fn name(&self) -> &str {
        "COMMAND_REGISTRY"
    }

    fn description(&self) -> &str {
        "Available chat commands and their descriptions"
    }

    fn position(&self) -> i32 {
        50
    }

    async fn get(
        &self,
        message: &Value,
        _state: &Value,
        registry: Option<&CommandRegistry>,
    ) -> ProviderResult {
        let text = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let is_cmd = is_command(text);

        let Some(reg) = registry else {
            return ProviderResult {
                values: json!({ "commandCount": 0, "isCommand": is_cmd }),
                text: String::new(),
                data: json!({ "isCommand": is_cmd }),
            };
        };

        let commands = reg.list_all();
        let count = commands.len();

        if is_cmd {
            let command_lines: Vec<String> = commands
                .iter()
                .filter(|c| !c.hidden)
                .map(|c| format!("- /{}: {}", c.name, c.description))
                .collect();

            let full_text = format!(
                "The user sent a slash command. Available commands:\n{}\n\nIMPORTANT: This is a slash command — respond by executing the matching command action, not with conversational text.",
                command_lines.join("\n")
            );

            ProviderResult {
                values: json!({
                    "commandCount": count,
                    "isCommand": true,
                }),
                text: full_text,
                data: json!({
                    "isCommand": true,
                    "commands": commands.iter().map(|c| json!({
                        "name": c.name,
                        "description": c.description,
                        "category": c.category,
                    })).collect::<Vec<_>>(),
                }),
            }
        } else {
            ProviderResult {
                values: json!({
                    "commandCount": count,
                    "isCommand": false,
                }),
                text: String::new(),
                data: json!({ "isCommand": false }),
            }
        }
    }
}
