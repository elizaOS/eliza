//! LOBSTER_RUN action for running Lobster pipelines

use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use tracing::info;

use crate::generated::specs::require_action_spec;
use crate::service::LobsterService;
use crate::{Action, ActionExample, ActionResult};

/// Extract a value from an XML tag
fn extract_xml_value(text: &str, tag: &str) -> Option<String> {
    let pattern = format!(r"<{}>(.*?)</{}>", tag, tag);
    let re = Regex::new(&pattern).ok()?;
    re.captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_string())
}

/// Action to run a Lobster pipeline
pub struct LobsterRunAction {
    name: &'static str,
    description: &'static str,
    similes: Vec<&'static str>,
    examples: Vec<ActionExample>,
}

impl LobsterRunAction {
    pub fn new() -> Self {
        let spec = require_action_spec("LOBSTER_RUN");
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

    fn extract_pipeline(&self, text: &str) -> Option<String> {
        // Try XML format first
        if let Some(pipeline) = extract_xml_value(text, "pipeline") {
            return Some(pipeline);
        }

        let lower = text.to_lowercase();

        // "lobster run <pipeline>"
        let re = Regex::new(r"lobster\s+run\s+(\S+)").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        // "run <pipeline> pipeline"
        let re = Regex::new(r"run\s+(?:the\s+)?(\S+)\s+pipeline").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        // "execute <pipeline>"
        let re = Regex::new(r"execute\s+(?:the\s+)?(\S+)").ok()?;
        if let Some(caps) = re.captures(&lower) {
            return Some(caps.get(1)?.as_str().to_string());
        }

        None
    }
}

impl Default for LobsterRunAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Action for LobsterRunAction {
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

        lower.contains("lobster run")
            || lower.contains("start lobster")
            || (lower.contains("run") && lower.contains("pipeline"))
            || lower.contains("execute pipeline")
    }

    async fn handler(
        &self,
        message: &Value,
        _state: &Value,
        service: Option<&mut LobsterService>,
    ) -> ActionResult {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let pipeline = match self.extract_pipeline(content) {
            Some(p) => p,
            None => {
                return ActionResult {
                    success: false,
                    text: "Please specify a pipeline to run. Example: `lobster run deploy-pipeline`".to_string(),
                    data: None,
                    error: Some("No pipeline specified".to_string()),
                };
            }
        };

        // Parse args if provided
        let args: Option<HashMap<String, serde_json::Value>> =
            extract_xml_value(content, "args")
                .or_else(|| extract_xml_value(content, "args_json"))
                .and_then(|json| serde_json::from_str(&json).ok());

        let cwd = extract_xml_value(content, "cwd");

        info!("Running Lobster pipeline: {}", pipeline);

        let svc = match service {
            Some(s) => s,
            None => {
                return ActionResult {
                    success: false,
                    text: "Lobster service not available".to_string(),
                    data: None,
                    error: Some("Service unavailable".to_string()),
                };
            }
        };

        let result = svc.run(&pipeline, args, cwd.as_deref()).await;

        if !result.success {
            return ActionResult {
                success: false,
                text: format!("Pipeline failed: {}", result.error.unwrap_or_default()),
                data: None,
                error: result.error,
            };
        }

        if result.status == "needs_approval" {
            if let Some(approval) = &result.approval {
                return ActionResult {
                    success: true,
                    text: format!(
                        "Pipeline paused for approval.\n\n**Step:** {}\n**Description:** {}\n\nReply with 'approve' or 'reject' to continue.",
                        approval.step_name, approval.description
                    ),
                    data: Some(serde_json::json!({
                        "status": "needs_approval",
                        "resumeToken": approval.resume_token,
                        "stepName": approval.step_name,
                    })),
                    error: None,
                };
            }
        }

        ActionResult {
            success: true,
            text: "Pipeline completed successfully.".to_string(),
            data: Some(serde_json::json!({
                "status": "success",
                "outputs": result.outputs,
            })),
            error: None,
        }
    }

    fn examples(&self) -> Vec<ActionExample> {
        self.examples.clone()
    }
}
