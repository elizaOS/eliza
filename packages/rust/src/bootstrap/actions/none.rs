//! NONE action implementation.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action that does nothing.
pub struct NoneAction;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Action for NoneAction {
    fn name(&self) -> &'static str {
        "NONE"
    }

    fn similes(&self) -> &[&'static str] {
        &["NO_ACTION", "NO_RESPONSE", "PASS"]
    }

    fn description(&self) -> &'static str {
        "Do nothing and skip to the next action. Use this when no specific action \
         is required but processing should continue."
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        _runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        _state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        Ok(ActionResult::success("No action taken")
            .with_value("success", true)
            .with_value("noAction", true)
            .with_data("actionName", "NONE"))
    }
}

