//! PROSE_RUN action for running OpenProse programs

use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use tracing::info;

use crate::generated::specs::require_action_spec;
use crate::services::ProseService;
use crate::types::ProseStateMode;
use crate::{Action, ActionExample, ActionResult};

/// Extract a value from an XML tag
fn extract_xml_value(text: &str, tag: &str) -> Option<String> {
    let pattern = format!(r"(?i)<{}>([\s\S]*?)</{}>", tag, tag);
    let re = Regex::new(&pattern).ok()?;
    re.captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
}

/// Build the execution context for a prose run
fn build_execution_context(
    service: &ProseService,
    program_content: &str,
    run_id: &str,
    run_dir: &str,
    state_mode: ProseStateMode,
    inputs: Option<&HashMap<String, Value>>,
) -> String {
    let mut parts = Vec::new();

    parts.push(format!(
        r#"╔══════════════════════════════════════════════════════════════╗
║                    OpenProse VM Loading                       ║
╚══════════════════════════════════════════════════════════════╝

Run ID: {}
Run Directory: {}
State Mode: {}
"#,
        run_id, run_dir, state_mode
    ));

    let vm_context = service.build_vm_context(state_mode, false, false);
    parts.push(vm_context);

    parts.push(format!(
        r#"
═══════════════════════════════════════════════════════════════
                      PROGRAM TO EXECUTE
═══════════════════════════════════════════════════════════════

```prose
{}
```
"#,
        program_content
    ));

    if let Some(inputs) = inputs {
        if !inputs.is_empty() {
            parts.push(format!(
                r#"
═══════════════════════════════════════════════════════════════
                        PROGRAM INPUTS
═══════════════════════════════════════════════════════════════

```json
{}
```
"#,
                serde_json::to_string_pretty(inputs).unwrap_or_default()
            ));
        }
    }

    parts.push(format!(
        r#"
═══════════════════════════════════════════════════════════════
                    EXECUTION INSTRUCTIONS
═══════════════════════════════════════════════════════════════

You are now the OpenProse VM. Your task is to execute the program above
by interpreting each statement according to the VM specification.

1. Parse the program structure (definitions, sessions, control flow)
2. Execute statements in order, using the Task tool for sessions
3. Maintain state in {} according to {} mode
4. Report progress and results back to the user

Begin execution now.
"#,
        run_dir, state_mode
    ));

    parts.join("\n")
}

/// Action to run an OpenProse program
pub struct ProseRunAction {
    name: &'static str,
    description: &'static str,
    similes: Vec<&'static str>,
    examples: Vec<ActionExample>,
}

impl ProseRunAction {
    pub fn new() -> Self {
        let spec = require_action_spec("PROSE_RUN");
        Self {
            name: spec.name,
            description: spec.description,
            similes: spec.similes.clone(),
            examples: spec
                .examples
                .iter()
                .map(|ex| ActionExample {
                    user_message: ex[0].1.to_string(),
                    agent_response: ex[1].1.to_string(),
                })
                .collect(),
        }
    }

    fn extract_file(&self, text: &str) -> Option<String> {
        if let Some(file) = extract_xml_value(text, "file") {
            return Some(file);
        }

        let lower = text.to_lowercase();

        // "prose run <file>"
        let re = Regex::new(r"prose\s+run\s+(\S+)").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        // "run <file.prose>"
        let re = Regex::new(r"run\s+(\S+\.prose)").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        // "execute <file.prose>"
        let re = Regex::new(r"execute\s+(\S+\.prose)").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        None
    }
}

impl Default for ProseRunAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Action for ProseRunAction {
    fn name(&self) -> &str {
        self.name
    }

    fn similes(&self) -> Vec<&str> {
        self.similes.clone()
    }

    fn description(&self) -> &str {
        self.description
    }

    async fn validate(&self, message: &Value, _state: &Value) -> bool {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let lower = content.to_lowercase();

        lower.contains("prose run")
            || (lower.contains("run") && lower.contains(".prose"))
            || (lower.contains("execute") && lower.contains(".prose"))
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut ProseService>,
    ) -> ActionResult {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let file = match self.extract_file(content) {
            Some(f) => f,
            None => {
                return ActionResult {
                    success: false,
                    text: "Please specify a .prose file to run. Example: `prose run workflow.prose`".to_string(),
                    data: None,
                    error: Some("No file specified".to_string()),
                };
            }
        };

        let state_mode_str = extract_xml_value(content, "state_mode");
        let state_mode = match state_mode_str.as_deref() {
            Some("in-context") => ProseStateMode::InContext,
            Some("sqlite") => ProseStateMode::Sqlite,
            Some("postgres") => ProseStateMode::Postgres,
            _ => ProseStateMode::Filesystem,
        };

        let inputs: Option<HashMap<String, Value>> = extract_xml_value(content, "inputs_json")
            .and_then(|json| serde_json::from_str(&json).ok());

        let cwd = extract_xml_value(content, "cwd")
            .unwrap_or_else(|| std::env::current_dir().unwrap().display().to_string());

        let svc = match service {
            Some(s) => s,
            None => {
                return ActionResult {
                    success: false,
                    text: "Prose service not available".to_string(),
                    data: None,
                    error: Some("Service unavailable".to_string()),
                };
            }
        };

        let file_path = if Path::new(&file).is_absolute() {
            file.clone()
        } else {
            Path::new(&cwd).join(&file).display().to_string()
        };

        if !svc.file_exists(&file_path).await {
            // Check for examples
            if file.starts_with("examples/") || !file.contains('/') {
                let example_name = file.replace("examples/", "");
                if let Some(example_content) = svc.read_example(&example_name).await {
                    let workspace_dir = match svc.ensure_workspace(&cwd).await {
                        Ok(d) => d,
                        Err(e) => {
                            return ActionResult {
                                success: false,
                                text: format!("Failed to create workspace: {}", e),
                                data: None,
                                error: Some(e.to_string()),
                            };
                        }
                    };

                    let (run_id, run_dir) = match svc.create_run_directory(&workspace_dir, &example_content).await {
                        Ok(r) => r,
                        Err(e) => {
                            return ActionResult {
                                success: false,
                                text: format!("Failed to create run directory: {}", e),
                                data: None,
                                error: Some(e.to_string()),
                            };
                        }
                    };

                    let exec_context = build_execution_context(
                        svc,
                        &example_content,
                        &run_id,
                        &run_dir,
                        state_mode,
                        inputs.as_ref(),
                    );

                    return ActionResult {
                        success: true,
                        text: format!(
                            "Loading OpenProse VM for example: {}\n\nRun ID: {}\n\n{}",
                            example_name, run_id, exec_context
                        ),
                        data: Some(json!({
                            "runId": run_id,
                            "runDir": run_dir,
                            "stateMode": state_mode.as_str(),
                            "file": example_name,
                        })),
                        error: None,
                    };
                }
            }

            return ActionResult {
                success: false,
                text: format!("File not found: {}\n\nUse `prose examples` to see available example programs.", file_path),
                data: None,
                error: Some("File not found".to_string()),
            };
        }

        let program_content = match svc.read_prose_file(&file_path).await {
            Ok(c) => c,
            Err(e) => {
                return ActionResult {
                    success: false,
                    text: format!("Failed to read file: {}", e),
                    data: None,
                    error: Some(e.to_string()),
                };
            }
        };

        let workspace_dir = match svc.ensure_workspace(&cwd).await {
            Ok(d) => d,
            Err(e) => {
                return ActionResult {
                    success: false,
                    text: format!("Failed to create workspace: {}", e),
                    data: None,
                    error: Some(e.to_string()),
                };
            }
        };

        let (run_id, run_dir) = match svc.create_run_directory(&workspace_dir, &program_content).await {
            Ok(r) => r,
            Err(e) => {
                return ActionResult {
                    success: false,
                    text: format!("Failed to create run directory: {}", e),
                    data: None,
                    error: Some(e.to_string()),
                };
            }
        };

        info!("Starting prose run {} for {}", run_id, file);

        let exec_context = build_execution_context(
            svc,
            &program_content,
            &run_id,
            &run_dir,
            state_mode,
            inputs.as_ref(),
        );

        ActionResult {
            success: true,
            text: format!(
                "Loading OpenProse VM...\n\nRun ID: {}\nProgram: {}\nState Mode: {}\n\n{}",
                run_id, file, state_mode, exec_context
            ),
            data: Some(json!({
                "runId": run_id,
                "runDir": run_dir,
                "stateMode": state_mode.as_str(),
                "file": file,
            })),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        self.examples.clone()
    }
}
