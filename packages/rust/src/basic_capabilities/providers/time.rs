//! TIME provider implementation.

use async_trait::async_trait;
use chrono::Utc;
use once_cell::sync::Lazy;

use crate::deterministic::{
    build_conversation_seed, get_prompt_reference_timestamp_ms, parse_boolean_setting,
    parse_positive_integer_setting, DEFAULT_TIME_BUCKET_MS,
};
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
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let now_ms = Utc::now().timestamp_millis();
        let deterministic_enabled = parse_boolean_setting(
            runtime
                .get_setting("PROMPT_CACHE_DETERMINISTIC_TIME")
                .as_deref(),
        );
        let bucket_ms = parse_positive_integer_setting(
            runtime
                .get_setting("PROMPT_CACHE_TIME_BUCKET_MS")
                .as_deref(),
            DEFAULT_TIME_BUCKET_MS,
        );
        let seed = build_conversation_seed(
            &runtime.agent_id(),
            runtime.character().id.as_ref(),
            Some(message),
            state,
            "provider:time",
            Some(bucket_ms),
            now_ms,
        );
        let reference_ms =
            get_prompt_reference_timestamp_ms(deterministic_enabled, bucket_ms, &seed, now_ms);
        let now =
            chrono::DateTime::<Utc>::from_timestamp_millis(reference_ms).unwrap_or_else(Utc::now);
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
