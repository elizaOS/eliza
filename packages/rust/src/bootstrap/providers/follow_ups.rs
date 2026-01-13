//! Follow-ups provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for follow-up reminders.
pub struct FollowUpsProvider;

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl Provider for FollowUpsProvider {
    fn name(&self) -> &'static str {
        "FOLLOW_UPS"
    }

    fn description(&self) -> &'static str {
        "Provides information about upcoming follow-ups and reminders"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        // Check if follow_up service is available
        if runtime.get_service("follow_up").is_none() {
            return Ok(ProviderResult::empty());
        }

        // Return service availability indicator
        // Full integration with FollowUpService would query pending follow-ups
        Ok(ProviderResult::with_text(
            "Follow-up reminders available via the follow-up service.".to_string(),
        )
        .with_value("followUpsAvailable", true))
    }
}

