use crate::advanced_memory::memory_service::MemoryService;
use crate::advanced_memory::prompts::{
    INITIAL_SUMMARIZATION_TEMPLATE, UPDATE_SUMMARIZATION_TEMPLATE,
};
use crate::advanced_memory::types::SummaryResult;
use crate::runtime::AgentRuntime;
use crate::types::components::{
    ActionResult, EvaluatorDefinition, EvaluatorHandler, HandlerOptions,
};
use crate::types::database::GetMemoriesParams;
use crate::types::memory::Memory;
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

/// Check if a message is a dialogue message (not action_result).
/// Matches the TypeScript `isDialogueMessage` filter.
fn is_dialogue_message(msg: &Memory) -> bool {
    let content_type = msg.content.content_type.as_deref().unwrap_or("");
    let meta_type = msg
        .metadata
        .as_ref()
        .and_then(|m| match m {
            crate::types::memory::MemoryMetadata::Custom(serde_json::Value::Object(map)) => {
                map.get("type").and_then(|v| v.as_str())
            }
            _ => None,
        })
        .unwrap_or("");

    let is_action_result = content_type == "action_result" && meta_type == "action_result";
    let is_dialogue = meta_type == "agent_response_message" || meta_type == "user_message";

    !is_action_result && is_dialogue
}

/// Parse XML summary response from LLM
fn parse_summary_xml(xml: &str) -> SummaryResult {
    let summary = regex_capture(xml, r"<text>([\s\S]*?)</text>")
        .unwrap_or_else(|| "Summary not available".to_string())
        .trim()
        .to_string();

    let topics = regex_capture(xml, r"<topics>([\s\S]*?)</topics>")
        .map(|t| {
            t.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let key_points = regex_capture_all(xml, r"<point>([\s\S]*?)</point>");

    SummaryResult {
        summary,
        topics,
        key_points,
    }
}

fn regex_capture(text: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn regex_capture_all(text: &str, pattern: &str) -> Vec<String> {
    let re = match regex::Regex::new(pattern) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    re.captures_iter(text)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .collect()
}

/// Compose a prompt by replacing {{variable}} placeholders in a template.
fn compose_prompt(template: &str, vars: &[(&str, &str)]) -> String {
    let mut result = template.to_string();
    for (key, val) in vars {
        let placeholder = format!("{{{{{}}}}}", key);
        result = result.replace(&placeholder, val);
    }
    result
}

pub struct SummarizationEvaluator {
    runtime: Weak<AgentRuntime>,
}

impl SummarizationEvaluator {
    pub fn new(runtime: Weak<AgentRuntime>) -> Self {
        Self { runtime }
    }
}

#[async_trait::async_trait]
impl EvaluatorHandler for SummarizationEvaluator {
    fn definition(&self) -> EvaluatorDefinition {
        EvaluatorDefinition {
            name: "MEMORY_SUMMARIZATION".to_string(),
            description: "Automatically summarizes conversations to optimize context usage"
                .to_string(),
            always_run: Some(true),
            similes: Some(vec![
                "CONVERSATION_SUMMARY".to_string(),
                "CONTEXT_COMPRESSION".to_string(),
                "MEMORY_OPTIMIZATION".to_string(),
            ]),
            ..Default::default()
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        let text = message.content.text.as_deref().unwrap_or("");
        if text.is_empty() {
            return false;
        }

        let runtime = match self.runtime.upgrade() {
            Some(r) => r,
            None => return false,
        };

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

        // Get dialogue message count
        let dialogue_count = get_dialogue_count(&runtime, &message.room_id).await;

        // Check if summary exists
        let existing = memory_service
            .get_current_session_summary(message.room_id.clone())
            .await
            .unwrap_or(None);

        match existing {
            None => dialogue_count >= config.short_term_summarization_threshold,
            Some(summary) => {
                let new_count = dialogue_count - summary.last_message_offset;
                new_count >= config.short_term_summarization_interval
            }
        }
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
        let room_id = message.room_id.clone();

        info!("Starting summarization for room {}", room_id);

        let existing = memory_service
            .get_current_session_summary(room_id.clone())
            .await
            .unwrap_or(None);
        let last_offset = existing
            .as_ref()
            .map(|s| s.last_message_offset)
            .unwrap_or(0);

        // Get all messages
        let params = GetMemoriesParams {
            room_id: Some(room_id.clone()),
            table_name: "messages".to_string(),
            count: Some(1000),
            ..Default::default()
        };
        let db = runtime
            .database()
            .ok_or_else(|| anyhow::anyhow!("Database not available"))?;
        let all_messages = db.get_memories(params).await?;

        let all_dialogue: Vec<&Memory> = all_messages
            .iter()
            .filter(|m| is_dialogue_message(m))
            .collect();
        let total_dialogue_count = all_dialogue.len() as i32;
        let new_dialogue_count = total_dialogue_count - last_offset;

        if new_dialogue_count == 0 {
            debug!("No new dialogue messages to summarize");
            return Ok(None);
        }

        let max_new = config.summary_max_new_messages.unwrap_or(50);
        let messages_to_process = new_dialogue_count.min(max_new);

        if new_dialogue_count > max_new {
            warn!(
                "Capping new dialogue at {} ({} available)",
                max_new, new_dialogue_count
            );
        }

        // Sort by timestamp
        let mut sorted_dialogue: Vec<&Memory> = all_dialogue;
        sorted_dialogue.sort_by_key(|m| m.created_at.unwrap_or(0));

        let new_messages: Vec<&Memory> = sorted_dialogue
            [last_offset as usize..(last_offset + messages_to_process) as usize]
            .to_vec();

        if new_messages.is_empty() {
            debug!("No new dialogue messages after slicing");
            return Ok(None);
        }

        // Format messages
        let agent_name = {
            let char_lock = runtime.character.read().await;
            char_lock.name.clone()
        };
        let formatted = new_messages
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

        // Build prompt
        let prompt = if let Some(ref ex) = existing {
            let topics_str = ex
                .topics
                .as_ref()
                .map(|t| t.join(", "))
                .unwrap_or_else(|| "None".to_string());
            compose_prompt(
                UPDATE_SUMMARIZATION_TEMPLATE,
                &[
                    ("existingSummary", &ex.summary),
                    ("existingTopics", &topics_str),
                    ("newMessages", &formatted),
                ],
            )
        } else {
            // Initial summary — use ALL dialogue
            let initial_formatted = sorted_dialogue
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
            compose_prompt(
                INITIAL_SUMMARIZATION_TEMPLATE,
                &[("recentMessages", &initial_formatted)],
            )
        };

        // Call LLM
        let max_tokens = config.summary_max_tokens.unwrap_or(2500);
        let params = serde_json::json!({
            "prompt": prompt,
            "maxTokens": max_tokens,
        });
        let response = runtime
            .use_model(crate::types::model::model_type::TEXT_LARGE, params)
            .await?;

        let result = parse_summary_xml(&response);
        info!(
            "{} summary: {}...",
            if existing.is_some() {
                "Updated"
            } else {
                "Generated"
            },
            &result.summary[..result.summary.len().min(100)]
        );

        let new_offset = last_offset + new_messages.len() as i32;
        let now = now_unix();

        if let Some(ex) = existing {
            let updated = crate::advanced_memory::types::SessionSummary {
                id: crate::types::primitives::UUID::new_v4(),
                agent_id: ex.agent_id,
                room_id: room_id.clone(),
                entity_id: ex.entity_id,
                summary: result.summary,
                message_count: ex.message_count + new_messages.len() as i32,
                last_message_offset: new_offset,
                start_time: ex.start_time,
                end_time: now,
                topics: Some(result.topics),
                metadata: {
                    let mut m = serde_json::Map::new();
                    m.insert(
                        "keyPoints".to_string(),
                        serde_json::to_value(&result.key_points).unwrap(),
                    );
                    Some(m)
                },
                embedding: None,
                created_at: ex.created_at,
                updated_at: now,
            };
            memory_service
                .update_session_summary(ex.id, room_id.clone(), updated)
                .await?;
            info!(
                "Updated summary for room {}: {} messages processed",
                room_id,
                new_messages.len()
            );
        } else {
            let first_ts = new_messages
                .first()
                .and_then(|m| m.created_at)
                .unwrap_or(now);
            let new_summary = crate::advanced_memory::types::SessionSummary {
                id: crate::types::primitives::UUID::new_v4(),
                agent_id: runtime.agent_id.clone(),
                room_id: room_id.clone(),
                entity_id: if message.entity_id != runtime.agent_id {
                    Some(message.entity_id.clone())
                } else {
                    None
                },
                summary: result.summary,
                message_count: total_dialogue_count,
                last_message_offset: total_dialogue_count,
                start_time: first_ts,
                end_time: now,
                topics: Some(result.topics),
                metadata: {
                    let mut m = serde_json::Map::new();
                    m.insert(
                        "keyPoints".to_string(),
                        serde_json::to_value(&result.key_points).unwrap(),
                    );
                    Some(m)
                },
                embedding: None,
                created_at: now,
                updated_at: now,
            };
            memory_service.store_session_summary(new_summary).await?;
            info!(
                "Created summary for room {}: {} messages summarized",
                room_id, total_dialogue_count
            );
        }

        Ok(None)
    }
}

/// Count dialogue messages in a room, excluding action results.
async fn get_dialogue_count(
    runtime: &AgentRuntime,
    room_id: &crate::types::primitives::UUID,
) -> i32 {
    let params = GetMemoriesParams {
        room_id: Some(room_id.clone()),
        table_name: "messages".to_string(),
        count: Some(100),
        ..Default::default()
    };

    let db = match runtime.database() {
        Some(d) => d,
        None => return 0,
    };

    let messages = db.get_memories(params).await.unwrap_or_default();
    messages.iter().filter(|m| is_dialogue_message(m)).count() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_summary_xml_valid() {
        let xml = r#"
<summary>
  <text>The user discussed their favorite coffee.</text>
  <topics>coffee, preferences, beverages</topics>
  <key_points>
    <point>User prefers dark roast</point>
    <point>User drinks 3 cups daily</point>
  </key_points>
</summary>"#;
        let result = parse_summary_xml(xml);
        assert_eq!(result.summary, "The user discussed their favorite coffee.");
        assert_eq!(result.topics, vec!["coffee", "preferences", "beverages"]);
        assert_eq!(result.key_points.len(), 2);
        assert_eq!(result.key_points[0], "User prefers dark roast");
        assert_eq!(result.key_points[1], "User drinks 3 cups daily");
    }

    #[test]
    fn parse_summary_xml_malformed() {
        let xml = "This is not XML at all";
        let result = parse_summary_xml(xml);
        assert_eq!(result.summary, "Summary not available");
        assert!(result.topics.is_empty());
        assert!(result.key_points.is_empty());
    }

    #[test]
    fn parse_summary_xml_partial_tags() {
        let xml = "<text>Just a summary</text>";
        let result = parse_summary_xml(xml);
        assert_eq!(result.summary, "Just a summary");
        assert!(result.topics.is_empty());
        assert!(result.key_points.is_empty());
    }

    #[test]
    fn parse_summary_xml_empty_topics() {
        let xml = "<text>Summary here</text><topics></topics>";
        let result = parse_summary_xml(xml);
        assert_eq!(result.summary, "Summary here");
        assert!(result.topics.is_empty());
    }

    #[test]
    fn compose_prompt_replaces_variables() {
        let tmpl = "Hello {{name}}, welcome to {{place}}.";
        let result = compose_prompt(tmpl, &[("name", "Alice"), ("place", "Wonderland")]);
        assert_eq!(result, "Hello Alice, welcome to Wonderland.");
    }

    #[test]
    fn compose_prompt_no_match() {
        let tmpl = "No placeholders here.";
        let result = compose_prompt(tmpl, &[("key", "val")]);
        assert_eq!(result, "No placeholders here.");
    }
}
