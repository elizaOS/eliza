//! Remove contact action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_action_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action to remove a contact from the rolodex.
pub struct RemoveContactAction;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("REMOVE_CONTACT"));

#[async_trait]
impl Action for RemoveContactAction {
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

        Ok(
            ActionResult::success(format!("Removed {} from contacts.", entity_name))
                .with_value("contactRemoved", true)
                .with_data("entityId", entity_id.to_string())
                .with_data("removed", true),
        )
    }
}
