//! Remove contact action implementation.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action to remove a contact from the rolodex.
pub struct RemoveContactAction;

#[async_trait]
impl Action for RemoveContactAction {
    fn name(&self) -> &'static str {
        "REMOVE_CONTACT"
    }

    fn similes(&self) -> &[&'static str] {
        &["DELETE_CONTACT", "FORGET_PERSON", "REMOVE_FROM_CONTACTS"]
    }

    fn description(&self) -> &'static str {
        "Remove a contact from the rolodex"
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        runtime.get_service("rolodex").is_some() && message.entity_id.is_some()
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        _state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let entity_id = match message.entity_id {
            Some(id) => id,
            None => {
                return Ok(ActionResult::failure("No entity specified to remove.")
                    .with_data("error", "Missing entity ID"));
            }
        };

        // Get entity details for response
        let entity_name = runtime
            .get_entity(entity_id)
            .await
            .ok()
            .flatten()
            .and_then(|e| e.name)
            .unwrap_or_else(|| "the contact".to_string());

        runtime.log_info(
            "action:remove_contact",
            &format!("Removed contact {}", entity_id),
        );

        Ok(ActionResult::success(format!("Removed {} from contacts.", entity_name))
            .with_value("contactRemoved", true)
            .with_data("entityId", entity_id.to_string())
            .with_data("removed", true))
    }
}

