use crate::advanced_memory::memory_service::MemoryService;
use crate::advanced_memory::prompts::LONG_TERM_EXTRACTION_TEMPLATE;
use crate::advanced_memory::types::{LongTermMemory, LongTermMemoryCategory, MemoryExtraction};
use crate::runtime::AgentRuntime;
use crate::types::components::{
    ActionResult, EvaluatorDefinition, EvaluatorHandler, HandlerOptions,
};
use crate::types::database::GetMemoriesParams;
use crate::types::memory::Memory;
use crate::types::primitives::UUID;
use crate::types::state::State;
use anyhow::Result;
use std::sync::Weak;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn now_iso() -> String {
    // Simple ISO format without chrono: unix timestamp as string
    let ts = now_unix();
    format!("{}", ts)
}

/// Parse XML memory extraction response from LLM.
fn parse_memory_extraction_xml(xml: &str) -> Vec<MemoryExtraction> {
    let re = match regex::Regex::new(
        r"<memory>[\s\S]*?<category>(.*?)</category>[\s\S]*?<content>(.*?)</content>[\s\S]*?<confidence>(.*?)</confidence>[\s\S]*?</memory>",
    ) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let valid_categories = ["episodic", "semantic", "procedural"];
    let mut extractions = Vec::new();

    for cap in re.captures_iter(xml) {
        let category_str = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        let content = cap.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        let confidence_str = cap.get(3).map(|m| m.as_str().trim()).unwrap_or("");

        if !valid_categories.contains(&category_str) {
            warn!("Invalid memory category: {}", category_str);
            continue;
        }

        let category = match category_str {
            "episodic" => LongTermMemoryCategory::Episodic,
            "semantic" => LongTermMemoryCategory::Semantic,
            "procedural" => LongTermMemoryCategory::Procedural,
            _ => continue,
        };

        let confidence: f32 = match confidence_str.parse() {
            Ok(c) => c,
            Err(_) => continue,
        };

        if !content.is_empty() {
            extractions.push(MemoryExtraction {
                category,
                content: content.to_string(),
                confidence,
            });
        }
    }

    extractions
}

/// Compose a prompt by replacing {{variable}} placeholders.
fn compose_prompt(template: &str, vars: &[(&str, &str)]) -> String {
    let mut result = template.to_string();
    for (key, val) in vars {
        let placeholder = format!("{{{{{}}}}}", key);
        result = result.replace(&placeholder, val);
    }
    result
}

pub struct LongTermExtractionEvaluator {
    runtime: Weak<AgentRuntime>,
}

impl LongTermExtractionEvaluator {
    pub fn new(runtime: Weak<AgentRuntime>) -> Self {
        Self { runtime }
    }
}

#[async_trait::async_trait]
impl EvaluatorHandler for LongTermExtractionEvaluator {
    fn definition(&self) -> EvaluatorDefinition {
        EvaluatorDefinition {
            name: "LONG_TERM_MEMORY_EXTRACTION".to_string(),
            description: "Extracts long-term facts about users from conversations".to_string(),
            always_run: Some(true),
            similes: Some(vec![
                "MEMORY_EXTRACTION".to_string(),
                "FACT_LEARNING".to_string(),
                "USER_PROFILING".to_string(),
            ]),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let runtime = match self.runtime.upgrade() {
            Some(r) => r,
            None => return false,
        };

        // Skip agent's own messages
        if message.entity_id == runtime.agent_id {
            return false;
        }

        let text = message.content.text.as_deref().unwrap_or("");
        if text.is_empty() {
            return false;
        }

        let service_opt = runtime.get_service("memory").await;
        let service_arc = match service_opt {
            Some(s) => s,
            None => return false,
        };
        let memory_service = match service_arc.as_any().downcast_ref::<MemoryService>() {
            Some(s) => s,
            None => return false,
        };

        let config = memory_service.get_config();
        if !config.long_term_extraction_enabled {
            debug!("Long-term memory extraction is disabled");
            return false;
        }

        // Count messages in this room
        let current_count = count_room_messages(&runtime, &message.room_id).await;

        memory_service.should_run_extraction(&message.entity_id, &message.room_id, current_count)
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("Runtime dropped"))?;

        let service_opt = runtime.get_service("memory").await;
        let service_arc = match service_opt {
            Some(s) => s,
            None => {
                error!("MemoryService not found");
                return Ok(None);
            }
        };
        let memory_service = match service_arc.as_any().downcast_ref::<MemoryService>() {
            Some(s) => s,
            None => {
                error!("MemoryService type mismatch");
                return Ok(None);
            }
        };

        let config = memory_service.get_config();
        let entity_id = message.entity_id.clone();
        let room_id = message.room_id.clone();

        info!("Extracting long-term memories for entity {}", entity_id);

        // Get recent messages
        let params = GetMemoriesParams {
            room_id: Some(room_id.clone()),
            table_name: "messages".to_string(),
            count: Some(20),
            ..Default::default()
        };
        let db = runtime
            .database()
            .ok_or_else(|| anyhow::anyhow!("Database not available"))?;
        let recent_messages = db.get_memories(params).await?;

        let agent_name = {
            let char_lock = runtime.character.read().await;
            char_lock.name.clone()
        };

        let mut sorted_messages = recent_messages;
        sorted_messages.sort_by_key(|m| m.created_at.unwrap_or(0));

        let formatted_messages = sorted_messages
            .iter()
            .map(|msg| {
                let sender = if msg.agent_id.as_ref() == Some(&runtime.agent_id) {
                    agent_name.as_str()
                } else {
                    "User"
                };
                format!(
                    "{}: {}",
                    sender,
                    msg.content.text.as_deref().unwrap_or("[non-text message]")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        // Get existing long-term memories
        let existing_memories = memory_service
            .get_long_term_memories(entity_id.clone(), None, 30)
            .await?;

        let formatted_existing = if existing_memories.is_empty() {
            "None yet".to_string()
        } else {
            existing_memories
                .iter()
                .map(|m| {
                    format!(
                        "[{:?}] {} (confidence: {})",
                        m.category,
                        m.content,
                        m.confidence.unwrap_or(0.0)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };

        // Build prompt
        let prompt = compose_prompt(
            LONG_TERM_EXTRACTION_TEMPLATE,
            &[
                ("recentMessages", &formatted_messages),
                ("existingMemories", &formatted_existing),
            ],
        );

        // Call LLM
        let params = serde_json::json!({
            "prompt": prompt,
        });
        let response = runtime
            .use_model(crate::types::model::model_type::TEXT_LARGE, params)
            .await?;

        let extractions = parse_memory_extraction_xml(&response);
        info!("Extracted {} long-term memories", extractions.len());

        // Store high-confidence extractions
        let min_confidence = config.long_term_confidence_threshold.max(0.85);
        let now = now_unix();
        let extracted_at = now_iso();

        for extraction in &extractions {
            if extraction.confidence >= min_confidence {
                let mut meta = serde_json::Map::new();
                meta.insert(
                    "roomId".to_string(),
                    serde_json::Value::String(room_id.to_string()),
                );
                meta.insert(
                    "extractedAt".to_string(),
                    serde_json::Value::String(extracted_at.clone()),
                );

                let ltm = LongTermMemory {
                    id: UUID::new_v4(),
                    agent_id: runtime.agent_id.clone(),
                    entity_id: entity_id.clone(),
                    category: extraction.category.clone(),
                    content: extraction.content.clone(),
                    confidence: Some(extraction.confidence),
                    source: Some("conversation".to_string()),
                    metadata: Some(meta),
                    embedding: None,
                    created_at: now,
                    updated_at: now,
                    last_accessed_at: None,
                    access_count: Some(0),
                    similarity: None,
                };

                memory_service.store_long_term_memory(ltm).await?;

                info!(
                    "Stored long-term memory: [{:?}] {}...",
                    extraction.category,
                    &extraction.content[..extraction.content.len().min(50)]
                );
            } else {
                debug!(
                    "Skipped low-confidence memory: {} (confidence: {}, threshold: {})",
                    extraction.content, extraction.confidence, min_confidence
                );
            }
        }

        // Update extraction checkpoint
        let current_count = count_room_messages(&runtime, &room_id).await;
        memory_service.set_last_extraction_checkpoint(&entity_id, &room_id, current_count);
        debug!(
            "Updated checkpoint to {} for entity {} in room {}",
            current_count, entity_id, room_id
        );

        Ok(None)
    }
}

/// Count total messages in a room.
async fn count_room_messages(runtime: &AgentRuntime, room_id: &UUID) -> i32 {
    let params = GetMemoriesParams {
        room_id: Some(room_id.clone()),
        table_name: "messages".to_string(),
        count: Some(1000),
        ..Default::default()
    };

    let db = match runtime.database() {
        Some(d) => d,
        None => return 0,
    };

    db.get_memories(params).await.unwrap_or_default().len() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_extraction_xml_valid_multiple() {
        let xml = r#"
<memories>
  <memory>
    <category>semantic</category>
    <content>User works as a software engineer</content>
    <confidence>0.95</confidence>
  </memory>
  <memory>
    <category>episodic</category>
    <content>User had a meeting yesterday</content>
    <confidence>0.8</confidence>
  </memory>
  <memory>
    <category>procedural</category>
    <content>User prefers TypeScript for backend</content>
    <confidence>0.9</confidence>
  </memory>
</memories>"#;
        let extractions = parse_memory_extraction_xml(xml);
        assert_eq!(extractions.len(), 3);

        assert!(matches!(
            extractions[0].category,
            LongTermMemoryCategory::Semantic
        ));
        assert_eq!(extractions[0].content, "User works as a software engineer");
        assert!((extractions[0].confidence - 0.95).abs() < 0.001);

        assert!(matches!(
            extractions[1].category,
            LongTermMemoryCategory::Episodic
        ));
        assert!((extractions[1].confidence - 0.8).abs() < 0.001);

        assert!(matches!(
            extractions[2].category,
            LongTermMemoryCategory::Procedural
        ));
    }

    #[test]
    fn parse_extraction_xml_invalid_category_skipped() {
        let xml = r#"
<memories>
  <memory>
    <category>invalid_type</category>
    <content>This should be skipped</content>
    <confidence>0.9</confidence>
  </memory>
  <memory>
    <category>semantic</category>
    <content>This should be kept</content>
    <confidence>0.85</confidence>
  </memory>
</memories>"#;
        let extractions = parse_memory_extraction_xml(xml);
        assert_eq!(extractions.len(), 1);
        assert_eq!(extractions[0].content, "This should be kept");
    }

    #[test]
    fn parse_extraction_xml_bad_confidence_skipped() {
        let xml = r#"
<memory>
  <category>semantic</category>
  <content>Bad confidence</content>
  <confidence>not_a_number</confidence>
</memory>"#;
        let extractions = parse_memory_extraction_xml(xml);
        assert_eq!(extractions.len(), 0);
    }

    #[test]
    fn parse_extraction_xml_empty_input() {
        let extractions = parse_memory_extraction_xml("");
        assert!(extractions.is_empty());
    }

    #[test]
    fn parse_extraction_xml_no_memories() {
        let xml = "The model didn't return any structured data.";
        let extractions = parse_memory_extraction_xml(xml);
        assert!(extractions.is_empty());
    }
}
