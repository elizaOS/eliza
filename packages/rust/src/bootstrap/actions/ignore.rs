//! IGNORE action implementation.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::Action;

/// Action for ignoring messages.
pub struct IgnoreAction;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Action for IgnoreAction {
    fn name(&self) -> &'static str {
        "IGNORE"
    }

    fn similes(&self) -> &[&'static str] {
        &["STOP_TALKING", "STOP_CHATTING", "STOP_CONVERSATION"]
    }

    fn description(&self) -> &'static str {
        "Call this action if ignoring the user. If the user is aggressive, creepy or is \
         finished with the conversation, use this action. Or, if both you and the user have \
         already said goodbye, use this action instead of saying bye again. Use IGNORE any \
         time the conversation has naturally ended. Do not use IGNORE if the user has engaged \
         directly, or if something went wrong and you need to tell them. Only ignore if the \
         user should be ignored."
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
        Ok(ActionResult::success("Ignored user")
            .with_value("success", true)
            .with_value("ignored", true)
            .with_data("actionName", "IGNORE"))
    }
}

