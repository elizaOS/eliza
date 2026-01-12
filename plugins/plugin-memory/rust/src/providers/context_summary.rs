use async_trait::async_trait;
use tracing::error;

use super::{MemoryProvider, ProviderContext, ProviderResult};
use crate::types::SessionSummary;

/// Provider for summarized conversation context.
///
/// This provider retrieves and formats session summaries to provide
/// agents with compressed context about previous conversations.
pub struct ContextSummaryProvider;

impl ContextSummaryProvider {
    /// Creates a new `ContextSummaryProvider`.
    pub fn new() -> Self {
        Self
    }

    /// Formats a session summary into displayable strings.
    ///
    /// Returns a tuple of (summary_only, summary_with_topics) where
    /// the first element is the basic summary and the second includes
    /// topic information if available.
    pub fn format_summary(&self, summary: &SessionSummary) -> (String, String) {
        let message_range = format!("{} messages", summary.message_count);
        let time_range = summary.start_time.format("%Y-%m-%d").to_string();

        let summary_only = format!(
            "**Previous Conversation** ({}, {})\n{}",
            message_range, time_range, summary.summary
        );

        let summary_with_topics = if !summary.topics.is_empty() {
            format!("{}\n*Topics: {}*", summary_only, summary.topics.join(", "))
        } else {
            summary_only.clone()
        };

        (summary_only, summary_with_topics)
    }

    fn add_header(header: &str, content: &str) -> String {
        if content.is_empty() {
            String::new()
        } else {
            format!("{}\n\n{}", header, content)
        }
    }
}

impl Default for ContextSummaryProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MemoryProvider for ContextSummaryProvider {
    fn name(&self) -> &'static str {
        "SUMMARIZED_CONTEXT"
    }

    fn description(&self) -> &'static str {
        "Provides summarized context from previous conversations"
    }

    fn position(&self) -> i32 {
        96
    }

    async fn get(&self, context: &ProviderContext) -> ProviderResult {
        let current_summary = context.state.get("currentSessionSummary");

        let summary: Option<SessionSummary> = current_summary.and_then(|v| {
            serde_json::from_value(v.clone())
                .map_err(|e| {
                    error!("Failed to deserialize session summary: {}", e);
                    e
                })
                .ok()
        });

        match summary {
            Some(s) => {
                let (summary_only, summary_with_topics) = self.format_summary(&s);
                let session_summaries = Self::add_header("# Conversation Summary", &summary_only);
                let session_summaries_with_topics =
                    Self::add_header("# Conversation Summary", &summary_with_topics);

                ProviderResult {
                    data: serde_json::json!({
                        "summaryText": s.summary,
                        "messageCount": s.message_count,
                        "topics": s.topics.join(", "),
                    }),
                    values: serde_json::json!({
                        "sessionSummaries": session_summaries,
                        "sessionSummariesWithTopics": session_summaries_with_topics,
                    }),
                    text: session_summaries_with_topics,
                }
            }
            None => ProviderResult::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    #[test]
    fn test_format_summary() {
        let provider = ContextSummaryProvider::new();

        let summary = SessionSummary {
            id: Uuid::new_v4(),
            agent_id: Uuid::new_v4(),
            room_id: Uuid::new_v4(),
            entity_id: None,
            summary: "User discussed Rust programming".to_string(),
            message_count: 15,
            last_message_offset: 15,
            start_time: Utc::now(),
            end_time: Utc::now(),
            topics: vec!["Rust".to_string(), "async".to_string()],
            metadata: serde_json::json!({}),
            embedding: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let (summary_only, summary_with_topics) = provider.format_summary(&summary);

        assert!(summary_only.contains("15 messages"));
        assert!(summary_only.contains("User discussed Rust programming"));
        assert!(!summary_only.contains("Topics:"));

        assert!(summary_with_topics.contains("Topics: Rust, async"));
    }

    #[test]
    fn test_format_summary_no_topics() {
        let provider = ContextSummaryProvider::new();

        let summary = SessionSummary {
            id: Uuid::new_v4(),
            agent_id: Uuid::new_v4(),
            room_id: Uuid::new_v4(),
            entity_id: None,
            summary: "Brief discussion".to_string(),
            message_count: 5,
            last_message_offset: 5,
            start_time: Utc::now(),
            end_time: Utc::now(),
            topics: vec![],
            metadata: serde_json::json!({}),
            embedding: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let (summary_only, summary_with_topics) = provider.format_summary(&summary);

        // When no topics, both should be the same
        assert_eq!(summary_only, summary_with_topics);
    }
}
