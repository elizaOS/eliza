//! FACTS provider implementation.

use async_trait::async_trait;
use once_cell::sync::Lazy;

use crate::error::PluginResult;
use crate::generated::spec_helpers::require_provider_spec;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, MemoryType, ProviderResult, State};

use super::Provider;

static SPEC: Lazy<&'static crate::generated::spec_helpers::ProviderDoc> =
    Lazy::new(|| require_provider_spec("FACTS"));

/// Provider for known facts about entities.
pub struct FactsProvider;

#[async_trait]
impl Provider for FactsProvider {
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
        let mut facts_list: Vec<serde_json::Value> = Vec::new();

        let entity_id = message.entity_id;
        let room_id = message.room_id;

        // Get facts about the sender
        if let Some(entity_id) = entity_id {
            match runtime
                .get_memories(None, Some(entity_id), Some(MemoryType::Fact), 10)
                .await
            {
                Ok(facts) => {
                    if !facts.is_empty() {
                        let sender = runtime.get_entity(entity_id).await.ok().flatten();
                        let sender_name = sender
                            .and_then(|s| s.name)
                            .unwrap_or_else(|| "User".to_string());

                        sections.push(format!("\n## Facts about {}", sender_name));

                        for fact in facts {
                            if !fact.content.text.is_empty() {
                                let mut fact_text = fact.content.text.clone();
                                if fact_text.len() > 200 {
                                    fact_text.truncate(200);
                                    fact_text.push_str("...");
                                }

                                facts_list.push(serde_json::json!({
                                    "entityId": entity_id.to_string(),
                                    "entityName": sender_name,
                                    "fact": fact_text
                                }));

                                sections.push(format!("- {}", fact_text));
                            }
                        }
                    }
                }
                Err(e) => {
                    runtime.log_warning("provider:facts", &format!("Error fetching facts: {}", e));
                }
            }
        }

        // Get facts about the room context
        if let Some(room_id) = room_id {
            match runtime
                .get_memories(Some(room_id), None, Some(MemoryType::Fact), 5)
                .await
            {
                Ok(facts) => {
                    if !facts.is_empty() {
                        sections.push("\n## Room Context Facts".to_string());

                        for fact in facts {
                            if !fact.content.text.is_empty() {
                                let mut fact_text = fact.content.text.clone();
                                if fact_text.len() > 200 {
                                    fact_text.truncate(200);
                                    fact_text.push_str("...");
                                }

                                facts_list.push(serde_json::json!({
                                    "roomId": room_id.to_string(),
                                    "fact": fact_text
                                }));

                                sections.push(format!("- {}", fact_text));
                            }
                        }
                    }
                }
                Err(e) => {
                    runtime.log_warning(
                        "provider:facts",
                        &format!("Error fetching room facts: {}", e),
                    );
                }
            }
        }

        let context_text = if sections.is_empty() {
            String::new()
        } else {
            format!("# Known Facts{}", sections.join("\n"))
        };

        Ok(ProviderResult::new(context_text)
            .with_value("factCount", facts_list.len() as i64)
            .with_value("hasFacts", !facts_list.is_empty())
            .with_data("facts", facts_list))
    }
}
