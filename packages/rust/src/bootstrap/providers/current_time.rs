//! CURRENT_TIME provider implementation.

use async_trait::async_trait;
use chrono::Utc;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Provider for current time information.
pub struct CurrentTimeProvider;

#[async_trait]
impl Provider for CurrentTimeProvider {
    fn name(&self) -> &'static str {
        "CURRENT_TIME"
    }

    fn description(&self) -> &'static str {
        "Provides current time and date information in various formats"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        _message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let now = Utc::now();

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
