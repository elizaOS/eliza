//! TIME provider implementation.

use async_trait::async_trait;
use chrono::Utc;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

// Get text content from centralized specs
static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("TIME"));

/// Provider for current time information (TS parity: `TIME`).
pub struct TimeProvider;

#[async_trait]
impl Provider for TimeProvider {
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
        _runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let now = Utc::now();
        let iso_string = now.to_rfc3339();
        let timestamp_ms = now.timestamp_millis();
        let human_readable = now.format("%A, %B %d, %Y at %H:%M:%S UTC").to_string();

        let text = format!(
            "The current date and time is {}. Please use this as your reference for any time-based operations or responses.",
            human_readable
        );

        Ok(ProviderResult::new(text)
            .with_value("time", human_readable)
            .with_data("timestamp", timestamp_ms)
            .with_data("isoString", iso_string))
    }
}
