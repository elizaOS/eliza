use crate::advanced_memory::memory_service::MemoryService;
use crate::runtime::AgentRuntime;
use crate::types::components::{ProviderDefinition, ProviderHandler, ProviderResult};
use crate::types::memory::Memory;
use crate::types::state::State;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Weak;
use tracing::error;

pub struct ContextSummaryProvider {
    runtime: Weak<AgentRuntime>,
}

impl ContextSummaryProvider {
    pub fn new(runtime: Weak<AgentRuntime>) -> Self {
        Self { runtime }
    }

    fn empty_result() -> ProviderResult {
        ProviderResult {
            text: Some(String::new()),
            values: Some(HashMap::from([
                (
                    "sessionSummaries".to_string(),
                    serde_json::Value::String(String::new()),
                ),
                (
                    "sessionSummariesWithTopics".to_string(),
                    serde_json::Value::String(String::new()),
                ),
            ])),
            data: Some(HashMap::from([(
                "summary".to_string(),
                serde_json::Value::Null,
            )])),
        }
    }
}

#[async_trait::async_trait]
impl ProviderHandler for ContextSummaryProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "SUMMARIZED_CONTEXT".to_string(),
            description: Some(
                "Provides summarized context from previous conversations".to_string(),
            ),
            ..Default::default()
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        let runtime = match self.runtime.upgrade() {
            Some(r) => r,
            None => return Ok(Self::empty_result()),
        };

        let service_opt = runtime.get_service("memory").await;
        let service_arc = match service_opt {
            Some(s) => s,
            None => return Ok(Self::empty_result()),
        };
        let memory_service = match service_arc.as_any().downcast_ref::<MemoryService>() {
            Some(s) => s,
            None => return Ok(Self::empty_result()),
        };

        let room_id = message.room_id.clone();
        let current_summary = match memory_service.get_current_session_summary(room_id).await {
            Ok(Some(s)) => s,
            Ok(None) => return Ok(Self::empty_result()),
            Err(e) => {
                error!("Error getting session summary: {:?}", e);
                return Ok(Self::empty_result());
            }
        };

        // Format summary without topics
        let message_range = format!("{} messages", current_summary.message_count);
        let mut summary_only = format!("**Previous Conversation** ({})\n", message_range);
        summary_only.push_str(&current_summary.summary);

        // Format with topics
        let mut summary_with_topics = summary_only.clone();
        if let Some(topics) = &current_summary.topics {
            if !topics.is_empty() {
                summary_with_topics.push_str(&format!("\n*Topics: {}*", topics.join(", ")));
            }
        }

        let session_summaries = format!("# Conversation Summary\n\n{}", summary_only);
        let session_summaries_with_topics =
            format!("# Conversation Summary\n\n{}", summary_with_topics);

        Ok(ProviderResult {
            text: Some(session_summaries_with_topics.clone()),
            values: Some(HashMap::from([
                (
                    "sessionSummaries".to_string(),
                    serde_json::Value::String(session_summaries),
                ),
                (
                    "sessionSummariesWithTopics".to_string(),
                    serde_json::Value::String(session_summaries_with_topics),
                ),
            ])),
            data: Some(HashMap::from([(
                "summary".to_string(),
                serde_json::to_value(&current_summary).unwrap_or(serde_json::Value::Null),
            )])),
        })
    }
}
