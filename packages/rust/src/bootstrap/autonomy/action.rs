//! Autonomy Actions for elizaOS - Rust implementation.
//!
//! Actions that enable autonomous agent communication.

use std::sync::Arc;

use crate::bootstrap::actions::Action;
use crate::bootstrap::error::PluginResult;
use crate::bootstrap::runtime::IAgentRuntime;
use crate::bootstrap::types::{ActionResult, Memory, State};

/// Send to Admin Action.
///
/// Allows agent to send messages to admin from autonomous context.
/// Only available in autonomous room to prevent misuse.
pub struct SendToAdminAction;

impl SendToAdminAction {
    /// Create a new SendToAdminAction.
    pub fn new() -> Self {
        Self
    }
}

impl Default for SendToAdminAction {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Action for SendToAdminAction {
    fn name(&self) -> &str {
        "SEND_TO_ADMIN"
    }

    fn description(&self) -> &str {
        "Send a message directly to the admin user from autonomous context"
    }

    fn similes(&self) -> Vec<&str> {
        vec!["NOTIFY_ADMIN", "MESSAGE_ADMIN", "ALERT_ADMIN"]
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        // Check for admin-related keywords in the message
        let text = message.content.text.to_lowercase();
        let admin_keywords = [
            "admin",
            "user",
            "tell",
            "notify",
            "inform",
            "update",
            "message",
            "send",
            "communicate",
            "report",
            "alert",
        ];

        admin_keywords.iter().any(|kw| text.contains(kw))
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&crate::bootstrap::types::HandlerOptions>,
    ) -> PluginResult<Option<ActionResult>> {
        // Extract message content
        let autonomous_thought = &message.content.text;

        // Generate message to admin
        let message_to_admin = if autonomous_thought.contains("completed")
            || autonomous_thought.contains("finished")
        {
            format!(
                "I've completed a task and wanted to update you. My thoughts: {}",
                autonomous_thought
            )
        } else if autonomous_thought.contains("problem")
            || autonomous_thought.contains("issue")
            || autonomous_thought.contains("error")
        {
            format!(
                "I encountered something that might need your attention: {}",
                autonomous_thought
            )
        } else if autonomous_thought.contains("question") || autonomous_thought.contains("unsure") {
            format!(
                "I have a question and would appreciate your guidance: {}",
                autonomous_thought
            )
        } else {
            format!("Autonomous update: {}", autonomous_thought)
        };

        Ok(Some(
            ActionResult::success(&message_to_admin)
                .with_data("sent", true)
                .with_data("messageContent", message_to_admin.clone()),
        ))
    }
}
