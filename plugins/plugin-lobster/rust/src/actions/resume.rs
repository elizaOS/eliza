//! LOBSTER_RESUME action for resuming paused pipelines

use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;
use tracing::info;

use crate::generated::specs::require_action_spec;
use crate::service::LobsterService;
use crate::{Action, ActionExample, ActionResult};

/// Action to resume a paused Lobster pipeline
pub struct LobsterResumeAction {
    name: &'static str,
    description: &'static str,
    similes: Vec<&'static str>,
    examples: Vec<ActionExample>,
}

impl LobsterResumeAction {
    pub fn new() -> Self {
        let spec = require_action_spec("LOBSTER_RESUME");
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

    fn determine_approval(&self, text: &str) -> bool {
        let lower = text.to_lowercase();
        let rejection_words = ["no", "reject", "cancel", "deny", "stop", "abort"];

        for word in rejection_words {
            if lower.contains(word) {
                return false;
            }
        }
        true
    }
}

impl Default for LobsterResumeAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Action for LobsterResumeAction {
    fn name(&self) -> &str {
        self.name
    }

    fn similes(&self) -> Vec<&str> {
        self.similes.clone()
    }

    fn description(&self) -> &str {
        self.description
    }

    async fn validate(&self, message: &Value, state: &Value) -> bool {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let lower = content.to_lowercase();

        // Check for pending token in state
        let pending_token = state
            .get("pendingLobsterToken")
            .and_then(|v| v.as_str());

        if pending_token.is_some() {
            let approval_words = ["approve", "yes", "continue", "reject", "no", "cancel"];
            if approval_words.iter().any(|word| lower.contains(word)) {
                return true;
            }
        }

        // Explicit resume command
        lower.contains("lobster resume")
            || (lower.contains("resume") && lower.contains("pipeline"))
    }

    async fn handler(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&mut LobsterService>,
    ) -> ActionResult {
        let content = message
            .get("content")
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let lower = content.to_lowercase();

        // Get token from state or message
        let mut token: Option<String> = state
            .get("pendingLobsterToken")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        if token.is_none() {
            // Try to extract from message
            let re = Regex::new(r"resume\s+(\S+)").ok();
            if let Some(re) = re {
                if let Some(caps) = re.captures(&lower) {
                    token = caps.get(1).map(|m| m.as_str().to_string());
                }
            }
        }

        let token = match token {
            Some(t) => t,
            None => {
                return ActionResult {
                    success: false,
                    text: "No pending pipeline to resume. Please provide a resume token.".to_string(),
                    data: None,
                    error: Some("No token available".to_string()),
                };
            }
        };

        let approve = self.determine_approval(content);

        info!("Resuming Lobster pipeline with token: {}, approve: {}", token, approve);

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

        let result = svc.resume(&token, approve).await;

        if !result.success {
            return ActionResult {
                success: false,
                text: format!("Failed to resume pipeline: {}", result.error.unwrap_or_default()),
                data: None,
                error: result.error,
            };
        }

        if result.status == "needs_approval" {
            if let Some(approval) = &result.approval {
                return ActionResult {
                    success: true,
                    text: format!(
                        "Pipeline reached another approval checkpoint.\n\n**Step:** {}\n**Description:** {}\n\nReply with 'approve' or 'reject' to continue.",
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

        let action_word = if approve { "approved" } else { "rejected" };
        ActionResult {
            success: true,
            text: format!("Pipeline {} and completed successfully.", action_word),
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
