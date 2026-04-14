//! MODIFY_CHARACTER action — apply character modifications.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::actions::Action;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};

use super::character_file_manager::CharacterFileManager;
use super::types::*;

/// Action to modify character traits or properties.
pub struct ModifyCharacterAction {
    service: Arc<CharacterFileManager>,
}

impl ModifyCharacterAction {
    /// Create a new ModifyCharacterAction.
    pub fn new(service: Arc<CharacterFileManager>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Action for ModifyCharacterAction {
    fn name(&self) -> &'static str {
        "MODIFY_CHARACTER"
    }

    fn similes(&self) -> &[&'static str] {
        &["UPDATE_CHARACTER", "EVOLVE_CHARACTER", "ADJUST_PERSONALITY"]
    }

    fn description(&self) -> &'static str {
        "Modify character traits or properties based on learned preferences"
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        _message: &Memory,
        state: Option<&State>,
        _responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        let params = state
            .and_then(|s| s.get_value("actionParams"))
            .cloned()
            .unwrap_or_default();

        let trait_name = params
            .get("trait")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                crate::error::PluginError::InvalidInput("Missing 'trait' parameter".to_string())
            })?;

        let intensity = params
            .get("intensity")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.5);

        let reason = params
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("user-requested modification");

        // Update the trait
        self.service
            .update_trait(trait_name, intensity)
            .await
            .map_err(|e| crate::error::PluginError::ActionFailed(e.to_string()))?;

        // Take a snapshot
        let character_name = runtime.character().name.clone();
        self.service
            .take_snapshot(
                &character_name,
                &format!("Modified trait '{}': {}", trait_name, reason),
            )
            .await;

        Ok(ActionResult::success(format!(
            "Updated character trait '{}' to intensity {:.2}",
            trait_name, intensity
        ))
        .with_data("trait", trait_name.to_string())
        .with_data("intensity", serde_json::json!(intensity))
        .with_data("actionName", "MODIFY_CHARACTER"))
    }
}
