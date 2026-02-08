//! Add contact action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_action_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action to add a new contact to the rolodex.
pub struct AddContactAction;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("ADD_CONTACT"));

#[async_trait]
impl Action for AddContactAction {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn similes(&self) -> &[&'static str] {
        static SIMILES: Lazy<Box<[&'static str]>> = Lazy::new(|| {
            SPEC.similes
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .into_boxed_slice()
        });
        &SIMILES
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool {
        // Check if rolodex service is available and we have an entity
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
                return Ok(
                    ActionResult::failure("No entity specified to add as contact.")
                        .with_data("error", "Missing entity ID"),
                );
            }
        };

        // Get entity details
        let entity = match runtime.get_entity(entity_id).await {
            Ok(Some(e)) => e,
            _ => {
                return Ok(ActionResult::failure("Entity not found.")
                    .with_data("error", "Entity not found"));
            }
        };

        // Extract categories from message text
        let text = message
            .content
            .text
            .as_ref()
            .map(|s| s.to_lowercase())
            .unwrap_or_default();

        let mut categories = Vec::new();
        if text.contains("friend") {
            categories.push("friend");
        }
        if text.contains("colleague") || text.contains("coworker") {
            categories.push("colleague");
        }
        if text.contains("family") {
            categories.push("family");
        }
        if categories.is_empty() {
            categories.push("acquaintance");
        }

        let entity_name = entity.name.unwrap_or_else(|| "contact".to_string());
        let cat_str = categories.join(", ");

        runtime.log_info(
            "action:add_contact",
            &format!("Added contact {} with categories: {}", entity_name, cat_str),
        );

        Ok(
            ActionResult::success(format!("Added {} to contacts as {}.", entity_name, cat_str))
                .with_value("contactAdded", true)
                .with_data("entityId", entity_id.to_string())
                .with_data("categories", cat_str),
        )
    }
}
