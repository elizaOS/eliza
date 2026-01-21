//! Follow-ups provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("FOLLOW_UPS"));

/// Provider for follow-up reminders.
pub struct FollowUpsProvider;

#[async_trait]
impl Provider for FollowUpsProvider {
    fn name(&self) -> &'static str {
        &SPEC.name
    }

    fn description(&self) -> &'static str {
        &SPEC.description
    }

    fn is_dynamic(&self) -> bool {
        SPEC.dynamic.unwrap_or(true)
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
