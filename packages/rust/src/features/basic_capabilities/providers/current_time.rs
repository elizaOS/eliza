//! CURRENT_TIME provider implementation.

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

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("CURRENT_TIME"));

/// Provider for current time information.
pub struct CurrentTimeProvider;

#[async_trait]
impl Provider for CurrentTimeProvider {
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
            "provider:current_time",
            Some(bucket_ms),
            now_ms,
        );
        let reference_ms =
            get_prompt_reference_timestamp_ms(deterministic_enabled, bucket_ms, &seed, now_ms);
        let now =
            chrono::DateTime::<Utc>::from_timestamp_millis(reference_ms).unwrap_or_else(Utc::now);

        let iso_timestamp = now.to_rfc3339();
        let human_readable = now.format("%A, %B %d, %Y at %H:%M:%S UTC").to_string();
        let date_only = now.format("%Y-%m-%d").to_string();
        let time_only = now.format("%H:%M:%S").to_string();
        let day_of_week = now.format("%A").to_string();
        let unix_timestamp = now.timestamp();

        let context_text = format!(
            r#"# Current Time
- Date: {}
- Time: {} UTC
- Day: {}
- Full: {}
- ISO: {}"#,
            date_only, time_only, day_of_week, human_readable, iso_timestamp
        );

        Ok(ProviderResult::new(context_text)
            .with_value("currentTime", iso_timestamp.clone())
            .with_value("currentDate", date_only.clone())
            .with_value("dayOfWeek", day_of_week.clone())
            .with_value("unixTimestamp", unix_timestamp)
            .with_data("iso", iso_timestamp)
            .with_data("date", date_only)
            .with_data("time", time_only)
            .with_data("dayOfWeek", day_of_week)
            .with_data("humanReadable", human_readable)
            .with_data("unixTimestamp", unix_timestamp))
    }
}
