//! USER_PERSONALITY provider — injects per-user personality preferences into context.

use async_trait::async_trait;
use std::sync::Arc;

use crate::basic_capabilities::providers::Provider;
use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::character_file_manager::CharacterFileManager;

/// Provider that surfaces per-user interaction preferences and character traits.
pub struct UserPersonalityProvider {
    service: Arc<CharacterFileManager>,
}

impl UserPersonalityProvider {
    /// Create a new UserPersonalityProvider.
    pub fn new(service: Arc<CharacterFileManager>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Provider for UserPersonalityProvider {
    fn name(&self) -> &'static str {
        "USER_PERSONALITY"
    }

    fn description(&self) -> &'static str {
        "Per-user interaction preferences and character traits"
    }

    fn is_dynamic(&self) -> bool {
        true
    }

    async fn get(
        &self,
        _runtime: &dyn IAgentRuntime,
        message: &Memory,
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let mut sections = Vec::new();

        // User preferences
        if let Some(entity_id) = message.entity_id {
            let prefs = self.service.get_preferences(entity_id).await;
            if !prefs.is_empty() {
                let pref_lines: Vec<String> = prefs
                    .iter()
                    .map(|p| format!("  - {}: {}", p.key, p.value))
                    .collect();
                sections.push(format!(
                    "## User Preferences\n{}",
                    pref_lines.join("\n")
                ));
            }
        }

        // Character traits
        let traits = self.service.get_traits().await;
        if !traits.is_empty() {
            let trait_lines: Vec<String> = traits
                .iter()
                .map(|t| {
                    let drift_indicator = if t.drift > 0.1 {
                        " (increasing)"
                    } else if t.drift < -0.1 {
                        " (decreasing)"
                    } else {
                        ""
                    };
                    format!(
                        "  - {}: {:.0}%{}",
                        t.name,
                        t.intensity * 100.0,
                        drift_indicator
                    )
                })
                .collect();
            sections.push(format!(
                "## Character Traits\n{}",
                trait_lines.join("\n")
            ));
        }

        if sections.is_empty() {
            return Ok(ProviderResult::new("")
                .with_value("hasPersonalityData", false));
        }

        let text = format!("# Personality\n{}", sections.join("\n\n"));
        Ok(ProviderResult::new(text)
            .with_value("hasPersonalityData", true)
            .with_value("traitCount", traits.len() as i64))
    }
}
