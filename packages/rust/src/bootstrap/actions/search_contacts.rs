//! Search contacts action implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;
use std::sync::Arc;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_action_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action to search contacts in the rolodex.
pub struct SearchContactsAction;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ActionDoc> =
    Lazy::new(|| require_action_spec("SEARCH_CONTACTS"));

#[async_trait]
impl Action for SearchContactsAction {
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

    async fn validate(&self, runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        runtime.get_service("rolodex").is_some()
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        _state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        // Parse search criteria from message
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

        let search_type = if categories.is_empty() {
            "all contacts"
        } else {
            "matching contacts"
        };

        let cat_str = categories.join(", ");

        runtime.log_info(
            "action:search_contacts",
            &format!("Searching contacts with categories: {}", cat_str),
        );

        Ok(ActionResult::success(format!(
            "Searching for {}{}.",
            search_type,
            if categories.is_empty() {
                String::new()
            } else {
                format!(" in categories: {}", cat_str)
            }
        ))
        .with_value("searchPerformed", true)
        .with_data("categories", cat_str))
    }
}
