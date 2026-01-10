//! AGENT_SETTINGS provider implementation.

use async_trait::async_trait;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

/// Sensitive key patterns to filter out.
const SENSITIVE_PATTERNS: &[&str] = &[
    "key", "secret", "password", "token", "credential", "auth", "private",
];

/// Provider for agent settings.
pub struct AgentSettingsProvider;

#[async_trait]
impl Provider for AgentSettingsProvider {
    fn name(&self) -> &'static str {
        "AGENT_SETTINGS"
    }

    fn description(&self) -> &'static str {
        "Provides the agent's current configuration settings (filtered for security)"
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
        let all_settings = runtime.get_all_settings();

        // Filter out sensitive settings
        let safe_settings: Vec<(String, String)> = all_settings
            .into_iter()
            .filter(|(k, _)| {
                let k_lower = k.to_lowercase();
                !SENSITIVE_PATTERNS
                    .iter()
                    .any(|pattern| k_lower.contains(pattern))
            })
            .collect();

        let mut sections = Vec::new();
        if !safe_settings.is_empty() {
            sections.push("# Agent Settings".to_string());
            for (key, value) in &safe_settings {
                let display_value = if value.len() > 50 {
                    format!("{}...", &value[..50])
                } else {
                    value.clone()
                };
                sections.push(format!("- {}: {}", key, display_value));
            }
        }

        let context_text = sections.join("\n");

        let settings_map: serde_json::Map<String, serde_json::Value> = safe_settings
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();

        Ok(ProviderResult::new(context_text)
            .with_value("settingsCount", settings_map.len() as i64)
            .with_value("hasSettings", !settings_map.is_empty())
            .with_data("settings", serde_json::Value::Object(settings_map)))
    }
}

