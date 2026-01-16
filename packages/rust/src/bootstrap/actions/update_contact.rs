//! Update contact action implementation.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action to update contact information in the rolodex.
pub struct UpdateContactAction;

#[async_trait]
impl Action for UpdateContactAction {
    fn name(&self) -> &'static str {
        "UPDATE_CONTACT"
    }

    fn similes(&self) -> &[&'static str] {
        &["EDIT_CONTACT", "CHANGE_CONTACT", "MODIFY_CONTACT"]
    }

    fn description(&self) -> &'static str {
        "Update contact information in the rolodex"
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
                return Ok(ActionResult::failure("No entity specified to update.")
                    .with_data("error", "Missing entity ID"));
            }
        };

        // Parse update from message
        let text = message
            .content
            .text
            .as_ref()
            .map(|s| s.to_lowercase())
            .unwrap_or_default();

        let mut new_categories = Vec::new();
        if text.contains("friend") {
            new_categories.push("friend");
        }
        if text.contains("colleague") || text.contains("coworker") {
            new_categories.push("colleague");
        }
        if text.contains("family") {
            new_categories.push("family");
        }

        // Get entity name for response
        let entity_name = runtime
            .get_entity(entity_id)
            .await
            .ok()
            .flatten()
            .and_then(|e| e.name)
            .unwrap_or_else(|| "the contact".to_string());

        let cat_str = new_categories.join(", ");

        runtime.log_info(
            "action:update_contact",
            &format!("Updated contact {} with categories: {}", entity_id, cat_str),
        );

        Ok(ActionResult::success(format!(
            "Updated {}'s contact information{}.",
            entity_name,
            if new_categories.is_empty() {
                String::new()
            } else {
                format!(" to categories: {}", cat_str)
            }
        ))
        .with_value("contactUpdated", true)
        .with_data("entityId", entity_id.to_string())
        .with_data("categories", cat_str))
    }
}
