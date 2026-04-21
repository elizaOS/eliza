use crate::advanced_memory::memory_service::MemoryService;
use crate::advanced_memory::types::LongTermMemory;
use crate::runtime::AgentRuntime;
use crate::types::components::{ProviderDefinition, ProviderHandler, ProviderResult};
use crate::types::memory::Memory;
use crate::types::primitives::UUID;
use crate::types::state::State;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Weak;

pub struct LongTermMemoryProvider {
    runtime: Weak<AgentRuntime>,
}

impl LongTermMemoryProvider {
    pub fn new(runtime: Weak<AgentRuntime>) -> Self {
        Self { runtime }
    }

    fn name(&self) -> String {
        "LONG_TERM_MEMORY".to_string()
    }

    fn empty_result() -> ProviderResult {
        ProviderResult {
            text: Some(String::new()),
            values: Some(HashMap::from([(
                "longTermMemories".to_string(),
                serde_json::Value::String(String::new()),
            )])),
            data: Some(HashMap::from([(
                "memoryCount".to_string(),
                serde_json::Value::Number(0.into()),
            )])),
        }
    }

    /// Format memories grouped by category, matching TypeScript/Python behavior.
    async fn get_formatted_memories(
        &self,
        service: &MemoryService,
        entity_id: UUID,
    ) -> (String, Vec<LongTermMemory>) {
        let memories = service
            .get_long_term_memories(entity_id, None, 25)
            .await
            .unwrap_or_default();

        if memories.is_empty() {
            return (String::new(), memories);
        }

        // Group by category (parity with TS getFormattedLongTermMemories)
        // Use Vec to preserve insertion order without indexmap dependency
        let mut grouped: Vec<(String, Vec<&LongTermMemory>)> = Vec::new();
        for mem in &memories {
            let cat_str = format!("{:?}", mem.category);
            if let Some(entry) = grouped.iter_mut().find(|(k, _)| k == &cat_str) {
                entry.1.push(mem);
            } else {
                grouped.push((cat_str, vec![mem]));
            }
        }

        let mut sections: Vec<String> = Vec::new();
        for (category, items) in &grouped {
            let category_name = category
                .split('_')
                .map(|w| {
                    let mut c = w.chars();
                    match c.next() {
                        None => String::new(),
                        Some(first) => {
                            first.to_uppercase().to_string() + &c.as_str().to_lowercase()
                        }
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let item_lines = items
                .iter()
                .map(|m| format!("- {}", m.content))
                .collect::<Vec<_>>()
                .join("\n");
            sections.push(format!("**{}**:\n{}", category_name, item_lines));
        }

        let formatted = sections.join("\n\n");
        let text = format!("# What I Know About You\n\n{}", formatted);
        (text, memories)
    }
}

#[async_trait::async_trait]
impl ProviderHandler for LongTermMemoryProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: self.name(),
            description: Some("Persistent facts and preferences about the user".to_string()),
            ..Default::default()
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("Runtime dropped"))?;

        let service_opt = runtime.get_service("memory").await;

        if let Some(service_arc) = service_opt {
            if let Some(memory_service) = service_arc.as_any().downcast_ref::<MemoryService>() {
                let entity_id = message.entity_id.clone();
                if entity_id == runtime.agent_id {
                    return Ok(Self::empty_result());
                }

                let (text, memories) = self.get_formatted_memories(memory_service, entity_id).await;

                if memories.is_empty() {
                    return Ok(Self::empty_result());
                }

                // Build category counts (parity with TS/Python)
                let mut category_counts: HashMap<String, usize> = HashMap::new();
                for mem in &memories {
                    let cat_str = format!("{:?}", mem.category);
                    *category_counts.entry(cat_str).or_insert(0) += 1;
                }
                let category_list = category_counts
                    .iter()
                    .map(|(cat, count)| format!("{}: {}", cat, count))
                    .collect::<Vec<_>>()
                    .join(", ");

                return Ok(ProviderResult {
                    text: Some(text.clone()),
                    values: Some(HashMap::from([
                        (
                            "longTermMemories".to_string(),
                            serde_json::Value::String(text),
                        ),
                        (
                            "memoryCategories".to_string(),
                            serde_json::Value::String(category_list.clone()),
                        ),
                    ])),
                    data: Some(HashMap::from([
                        (
                            "memoryCount".to_string(),
                            serde_json::Value::Number(memories.len().into()),
                        ),
                        (
                            "categories".to_string(),
                            serde_json::Value::String(category_list),
                        ),
                    ])),
                });
            }
        }

        Ok(Self::empty_result())
    }
}
