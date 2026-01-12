use async_trait::async_trait;
use tracing::{debug, info};

use super::{EvaluatorContext, EvaluatorResult, MemoryEvaluator};
use crate::config::MemoryConfig;
use crate::types::SummaryResult;

fn parse_summary_xml(xml: &str) -> SummaryResult {
    let summary = xml
        .find("<text>")
        .and_then(|start| {
            xml[start + 6..]
                .find("</text>")
                .map(|end| xml[start + 6..start + 6 + end].trim().to_string())
        })
        .unwrap_or_else(|| "Summary not available".to_string());

    let topics = xml
        .find("<topics>")
        .and_then(|start| {
            xml[start + 8..].find("</topics>").map(|end| {
                xml[start + 8..start + 8 + end]
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
        })
        .unwrap_or_default();

    let mut key_points = Vec::new();
    let mut remaining = xml;
    while let Some(start) = remaining.find("<point>") {
        if let Some(end) = remaining[start + 7..].find("</point>") {
            key_points.push(remaining[start + 7..start + 7 + end].trim().to_string());
            remaining = &remaining[start + 7 + end..];
        } else {
            break;
        }
    }

    SummaryResult {
        summary,
        topics,
        key_points,
    }
}

/// Evaluator for summarizing conversations to optimize context usage.
///
/// This evaluator determines when conversations should be summarized based on
/// message count thresholds and creates compressed representations of
/// conversation history.
pub struct SummarizationEvaluator {
    config: MemoryConfig,
}

impl SummarizationEvaluator {
    /// Creates a new `SummarizationEvaluator` with the given configuration.
    pub fn new(config: MemoryConfig) -> Self {
        Self { config }
    }

    /// Determines whether summarization should occur based on message counts.
    ///
    /// Returns `true` if the message count has reached the threshold for initial
    /// summarization or if enough new messages have accumulated since the last summary.
    pub fn should_summarize(&self, current_count: i32, last_offset: Option<i32>) -> bool {
        match last_offset {
            None => current_count >= self.config.short_term_summarization_threshold,
            Some(offset) => {
                let new_count = current_count - offset;
                new_count >= self.config.short_term_summarization_interval
            }
        }
    }

    /// Parses an XML response into a structured summary result.
    pub fn parse_response(&self, xml: &str) -> SummaryResult {
        parse_summary_xml(xml)
    }
}

#[async_trait]
impl MemoryEvaluator for SummarizationEvaluator {
    fn name(&self) -> &'static str {
        "MEMORY_SUMMARIZATION"
    }

    fn description(&self) -> &'static str {
        "Automatically summarizes conversations to optimize context usage"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "CONVERSATION_SUMMARY",
            "CONTEXT_COMPRESSION",
            "MEMORY_OPTIMIZATION",
        ]
    }

    async fn validate(&self, context: &EvaluatorContext) -> bool {
        if context.message_text.is_empty() {
            return false;
        }

        let last_offset = context
            .state
            .get("lastMessageOffset")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);

        self.should_summarize(context.message_count, last_offset)
    }

    async fn handler(&self, context: &EvaluatorContext) -> Option<EvaluatorResult> {
        info!("Starting summarization for room {}", context.room_id);

        debug!(
            "Summarization evaluator triggered for room {} with {} messages",
            context.room_id, context.message_count
        );

        Some(EvaluatorResult {
            success: true,
            data: Some(serde_json::json!({
                "evaluator": self.name(),
                "room_id": context.room_id.to_string(),
                "message_count": context.message_count,
            })),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_summary_xml() {
        let xml = r#"
            <summary>
                <text>This is a test summary</text>
                <topics>topic1, topic2, topic3</topics>
                <key_points>
                    <point>First key point</point>
                    <point>Second key point</point>
                </key_points>
            </summary>
        "#;

        let result = parse_summary_xml(xml);
        assert_eq!(result.summary, "This is a test summary");
        assert_eq!(result.topics, vec!["topic1", "topic2", "topic3"]);
        assert_eq!(
            result.key_points,
            vec!["First key point", "Second key point"]
        );
    }

    #[test]
    fn test_should_summarize_initial() {
        let config = MemoryConfig::default();
        let evaluator = SummarizationEvaluator::new(config.clone());

        // Below threshold
        assert!(!evaluator.should_summarize(10, None));

        // At threshold
        assert!(evaluator.should_summarize(config.short_term_summarization_threshold, None));

        // Above threshold
        assert!(evaluator.should_summarize(config.short_term_summarization_threshold + 5, None));
    }

    #[test]
    fn test_should_summarize_update() {
        let config = MemoryConfig::default();
        let evaluator = SummarizationEvaluator::new(config.clone());

        let last_offset = 20;

        // Below interval
        assert!(!evaluator.should_summarize(last_offset + 5, Some(last_offset)));

        // At interval
        assert!(evaluator.should_summarize(
            last_offset + config.short_term_summarization_interval,
            Some(last_offset)
        ));
    }
}
