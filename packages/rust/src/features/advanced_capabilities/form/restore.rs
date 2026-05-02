//! FORM_RESTORE action — restore a stashed form session.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::actions::Action;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::service::FormService;

/// Action to restore a previously stashed form session.
pub struct FormRestoreAction {
    service: Arc<FormService>,
}

impl FormRestoreAction {
    /// Create a new FormRestoreAction.
    pub fn new(service: Arc<FormService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for FormRestoreAction {
    fn name(&self) -> &'static str {
        "FORM_RESTORE"
    }

    fn similes(&self) -> &[&'static str] {
        &["RESTORE_FORM", "RESUME_FORM", "CONTINUE_FORM"]
    }

    fn description(&self) -> &'static str {
        "Restore a previously stashed form session to continue filling"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let entity_id = message
            .entity_id
            .ok_or_else(|| crate::error::PluginError::InvalidInput("No entity ID".to_string()))?;

        // Check for explicit session ID in params
        let session_id = state
            .and_then(|s| s.get_value("actionParams"))
            .and_then(|p| p.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(String::from);

        if let Some(sid) = session_id {
            match self.service.restore_session(&sid).await {
                Ok(session) => {
                    return Ok(ActionResult::success(format!(
                        "Restored form session for '{}'",
                        session.form_id
                    ))
                    .with_data("sessionId", session.id)
                    .with_data("formId", session.form_id)
                    .with_data("actionName", "FORM_RESTORE"));
                }
                Err(e) => {
                    return Ok(ActionResult::error(format!(
                        "Failed to restore session: {}",
                        e
                    )));
                }
            }
        }

        // Otherwise restore the most recent stashed session for this entity
        let stashed = self.service.get_stashed_sessions(entity_id).await;

        if stashed.is_empty() {
            return Ok(
                ActionResult::success("No stashed form sessions found".to_string())
                    .with_data("actionName", "FORM_RESTORE"),
            );
        }

        // Pick most recently updated
        let most_recent = stashed.iter().max_by_key(|s| s.updated_at).unwrap();

        match self.service.restore_session(&most_recent.id).await {
            Ok(session) => Ok(ActionResult::success(format!(
                "Restored form session for '{}'",
                session.form_id
            ))
            .with_data("sessionId", session.id)
            .with_data("formId", session.form_id)
            .with_data("actionName", "FORM_RESTORE")),
            Err(e) => Ok(ActionResult::error(format!(
                "Failed to restore session: {}",
                e
            ))),
        }
    }
}
