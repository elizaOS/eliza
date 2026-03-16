//! Prose provider for context injection

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::services::ProseService;
use crate::types::ProseStateMode;
use crate::{Provider, ProviderResult};

/// Provider that supplies OpenProse VM context
pub struct ProseProvider {
    name: &'static str,
    description: &'static str,
    position: i32,
}

impl ProseProvider {
    pub fn new() -> Self {
        Self {
            name: "prose",
            description: "Provides OpenProse VM context for running and authoring .prose programs",
            position: 100,
        }
    }
}

impl Default for ProseProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Provider for ProseProvider {
    fn name(&self) -> &str {
        self.name
    }

    fn description(&self) -> &str {
        self.description
    }

    fn position(&self) -> i32 {
        self.position
    }

    async fn get(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&ProseService>,
    ) -> ProviderResult {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let lower = content.to_lowercase();

        // Detect prose-related commands
        let is_prose_run =
            lower.contains("prose run") || (lower.contains("run") && lower.contains(".prose"));
        let is_prose_compile = lower.contains("prose compile")
            || (lower.contains("validate") && lower.contains(".prose"));
        let is_prose_help = lower.contains("prose help")
            || lower.contains("prose examples")
            || lower.contains("prose syntax")
            || lower.contains("how do i write a prose");
        let is_prose_update = lower.contains("prose update");

        // Not a prose command - return minimal context
        if !is_prose_run && !is_prose_compile && !is_prose_help && !is_prose_update {
            let active_run_id = state.get("proseRunId").and_then(|v| v.as_str());
            if active_run_id.is_none() {
                return ProviderResult {
                    values: json!({ "available": true }),
                    text: "OpenProse is available. Use \"prose run <file>\" to execute programs, \"prose help\" for guidance.".to_string(),
                    data: json!({ "available": true }),
                };
            }
        }

        // Get state mode from state or default
        let state_mode_str = state
            .get("proseStateMode")
            .and_then(|v| v.as_str())
            .unwrap_or("filesystem");

        let state_mode = match state_mode_str {
            "in-context" => ProseStateMode::InContext,
            "sqlite" => ProseStateMode::Sqlite,
            "postgres" => ProseStateMode::Postgres,
            _ => ProseStateMode::Filesystem,
        };

        let Some(svc) = service else {
            return ProviderResult {
                values: json!({ "available": false }),
                text: "OpenProse service not available.".to_string(),
                data: json!({ "available": false }),
            };
        };

        // For help/examples, return the skill spec and help docs
        if is_prose_help {
            let skill_spec = svc.get_skill_spec();
            let help_doc = svc.get_help();
            let examples = svc.list_examples().await;

            let mut parts = Vec::new();

            if let Some(spec) = skill_spec {
                parts.push("## OpenProse Skill\n".to_string());
                parts.push(spec);
            }

            if let Some(help) = help_doc {
                parts.push("\n## Help Documentation\n".to_string());
                parts.push(help);
            }

            if !examples.is_empty() {
                parts.push("\n## Available Examples\n".to_string());
                parts.push("The following example programs are available:\n".to_string());
                for ex in examples {
                    parts.push(format!("- {}", ex));
                }
                parts.push("\nUse \"prose run examples/<name>\" to run one.".to_string());
            }

            return ProviderResult {
                values: json!({ "available": true, "mode": "help" }),
                text: parts.join("\n"),
                data: json!({ "available": true, "mode": "help" }),
            };
        }

        // For compile/validate, include compiler spec
        if is_prose_compile {
            let context = svc.build_vm_context(state_mode, true, true);
            return ProviderResult {
                values: json!({ "available": true, "mode": "compile" }),
                text: context,
                data: json!({ "available": true, "mode": "compile" }),
            };
        }

        // For run or update, return full VM context
        if is_prose_run || is_prose_update {
            let context = svc.build_vm_context(state_mode, false, false);
            return ProviderResult {
                values: json!({ "available": true, "mode": "run" }),
                text: context,
                data: json!({ "available": true, "mode": "run", "stateMode": state_mode.as_str() }),
            };
        }

        // Default: minimal context
        ProviderResult {
            values: json!({ "available": true }),
            text: format!("OpenProse VM is ready. Active state mode: {}", state_mode),
            data: json!({ "available": true, "stateMode": state_mode.as_str() }),
        }
    }
}
