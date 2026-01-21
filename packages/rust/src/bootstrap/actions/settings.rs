//! UPDATE_SETTINGS action implementation.

use async_trait::async_trait;
use std::sync::Arc;

use crate::error::{PluginError, PluginResult};
use crate::prompts::UPDATE_SETTINGS_TEMPLATE;
use crate::runtime::{IAgentRuntime, ModelParams};
use crate::types::{ActionResult, Memory, ModelType, State};
use crate::xml::parse_key_value_xml;

use super::Action;
use crate::generated::spec_helpers::require_action_spec;
use once_cell::sync::Lazy;

/// Action for updating settings.
pub struct UpdateSettingsAction;

#[async_trait]
impl Action for UpdateSettingsAction {
    fn name(&self) -> &'static str {
        "UPDATE_SETTINGS"
    }

    fn similes(&self) -> &[&'static str] {
        &[
            "CHANGE_SETTINGS",
            "MODIFY_SETTINGS",
            "CONFIGURE",
            "SET_PREFERENCE",
            "UPDATE_CONFIG",
        ]
    }

    fn description(&self) -> &'static str {
        "Update configuration settings for the agent or world. \
         Use this to modify behavior and preferences."
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let _state = state.ok_or_else(|| {
            PluginError::StateRequired("State is required for UPDATE_SETTINGS action".to_string())
        })?;

        // Compose state
        let composed_state = runtime
            .compose_state(
                message,
                &["RECENT_MESSAGES", "ACTION_STATE", "AGENT_SETTINGS"],
            )
            .await?;

        // Get current settings
        let all_settings = runtime.get_all_settings();
        let safe_settings: Vec<(String, String)> = all_settings
            .into_iter()
            .filter(|(k, _)| {
                let k_lower = k.to_lowercase();
                !k_lower.contains("key")
                    && !k_lower.contains("secret")
                    && !k_lower.contains("password")
                    && !k_lower.contains("token")
            })
            .collect();

        let settings_text: String = safe_settings
            .iter()
            .map(|(k, v)| format!("- {}: {}", k, v))
            .collect::<Vec<_>>()
            .join("\n");

        // Get template and compose prompt
        let template = runtime
            .character()
            .templates
            .get("updateSettingsTemplate")
            .map(|s| s.as_str())
            .unwrap_or(UPDATE_SETTINGS_TEMPLATE);

        let prompt = runtime
            .compose_prompt(&composed_state, template)
            .replace("{{settings}}", &settings_text);

        // Call the model
        let response = runtime
            .use_model(ModelType::TextLarge, ModelParams::with_prompt(&prompt))
            .await
            .map_err(|e| PluginError::ModelError(e.to_string()))?;

        let response_text = response
            .as_text()
            .ok_or_else(|| PluginError::ModelError("Expected text response".to_string()))?;

        // Parse XML response
        let parsed = parse_key_value_xml(response_text)
            .ok_or_else(|| PluginError::XmlParse("Failed to parse response XML".to_string()))?;

        let thought = parsed.get("thought").cloned().unwrap_or_default();
        let key = parsed.get("key").cloned();
        let value = parsed.get("value").cloned();

        if let (Some(k), Some(v)) = (key.clone(), value.clone()) {
            runtime.set_setting(&k, &v).await?;

            Ok(
                ActionResult::success(format!("Updated setting: {} = {}", k, v))
                    .with_value("success", true)
                    .with_value("settingsUpdated", true)
                    .with_value("updatedKey", k.clone())
                    .with_data("actionName", "UPDATE_SETTINGS")
                    .with_data("key", k)
                    .with_data("value", v)
                    .with_data("thought", thought),
            )
        } else {
            Ok(ActionResult::success("No settings to update")
                .with_value("success", true)
                .with_value("noChanges", true)
                .with_data("actionName", "UPDATE_SETTINGS")
                .with_data("thought", thought))
        }
    }
}
