//! ENTITIES provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("ENTITIES"));

/// Provider for entity information.
pub struct EntitiesProvider;

#[async_trait]
impl Provider for EntitiesProvider {
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
        _state: Option<&State>,
    ) -> PluginResult<ProviderResult> {
        let mut sections = Vec::new();
        let mut entity_list: Vec<serde_json::Value> = Vec::new();

        let sender_id = message.entity_id;

        // Get sender entity
        if let Some(sender_id) = sender_id {
            if let Ok(Some(sender)) = runtime.get_entity(sender_id).await {
                let sender_name = sender.name.clone().unwrap_or_else(|| "Unknown".to_string());
                let sender_type = sender
                    .entity_type
                    .clone()
                    .unwrap_or_else(|| "user".to_string());

                entity_list.push(serde_json::json!({
                    "id": sender_id.to_string(),
                    "name": sender_name,
                    "type": sender_type,
                    "role": "sender"
                }));

                sections.push(format!("- **{}** (sender): {}", sender_name, sender_type));
            }
        }

        // Add agent itself
        let agent_id = runtime.agent_id();
        if let Ok(Some(agent)) = runtime.get_entity(agent_id).await {
            let agent_name = agent
                .name
                .clone()
                .unwrap_or_else(|| runtime.character().name.clone());

            entity_list.push(serde_json::json!({
                "id": agent_id.to_string(),
                "name": agent_name,
                "type": "agent",
                "role": "self"
            }));

            sections.push(format!("- **{}** (self): agent", agent_name));
        }

        let context_text = if sections.is_empty() {
            String::new()
        } else {
            format!("# Entities in Context\n{}", sections.join("\n"))
        };

        Ok(ProviderResult::new(context_text)
            .with_value("entityCount", entity_list.len() as i64)
            .with_value("hasSender", sender_id.is_some())
            .with_value("agentId", agent_id.to_string())
            .with_data("entities", entity_list)
            .with_data("agentId", agent_id.to_string()))
    }
}
