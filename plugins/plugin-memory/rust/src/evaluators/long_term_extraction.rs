use async_trait::async_trait;
use tracing::{debug, info, warn};

use super::{EvaluatorContext, EvaluatorResult, MemoryEvaluator};
use crate::config::MemoryConfig;
use crate::types::{LongTermMemoryCategory, MemoryExtraction};

fn parse_memory_extraction_xml(xml: &str) -> Vec<MemoryExtraction> {
    let mut extractions = Vec::new();
    let mut remaining = xml;

    while let Some(mem_start) = remaining.find("<memory>") {
        if let Some(mem_end) = remaining[mem_start..].find("</memory>") {
            let memory_block = &remaining[mem_start..mem_start + mem_end + 9];

            let category = memory_block.find("<category>").and_then(|start| {
                memory_block[start + 10..]
                    .find("</category>")
                    .map(|end| memory_block[start + 10..start + 10 + end].trim())
            });

            let content = memory_block.find("<content>").and_then(|start| {
                memory_block[start + 9..]
                    .find("</content>")
                    .map(|end| memory_block[start + 9..start + 9 + end].trim().to_string())
            });

            let confidence = memory_block.find("<confidence>").and_then(|start| {
                memory_block[start + 12..]
                    .find("</confidence>")
                    .and_then(|end| {
                        memory_block[start + 12..start + 12 + end]
                            .trim()
                            .parse::<f64>()
                            .ok()
                    })
            });

            if let (Some(cat_str), Some(content), Some(conf)) = (category, content, confidence) {
                match cat_str.parse::<LongTermMemoryCategory>() {
                    Ok(category) => {
                        extractions.push(MemoryExtraction {
                            category,
                            content,
                            confidence: conf,
                            metadata: serde_json::json!({}),
                        });
                    }
                    Err(e) => {
                        warn!("Invalid memory category: {}", e);
                    }
                }
            }

            remaining = &remaining[mem_start + mem_end + 9..];
        } else {
            break;
        }
    }

    extractions
}

/// Evaluator for extracting long-term memories from conversations.
///
/// This evaluator analyzes conversation content to identify facts, preferences,
/// and other persistent information about users that should be stored in
/// long-term memory for future reference.
pub struct LongTermExtractionEvaluator {
    config: MemoryConfig,
}

impl LongTermExtractionEvaluator {
    /// Creates a new `LongTermExtractionEvaluator` with the given configuration.
    pub fn new(config: MemoryConfig) -> Self {
        Self { config }
    }

    /// Determines whether memory extraction should occur based on message counts.
    ///
    /// Returns `true` if the current message count has crossed an extraction
    /// checkpoint since the last extraction.
    pub fn should_extract(&self, current_count: i32, last_checkpoint: i32) -> bool {
        if !self.config.long_term_extraction_enabled {
            return false;
        }

        if current_count < self.config.long_term_extraction_threshold {
            return false;
        }

        let current_checkpoint = (current_count / self.config.long_term_extraction_interval)
            * self.config.long_term_extraction_interval;

        current_checkpoint > last_checkpoint
    }

    /// Parses an XML response into a list of memory extractions.
    pub fn parse_response(&self, xml: &str) -> Vec<MemoryExtraction> {
        parse_memory_extraction_xml(xml)
    }

    /// Filters extractions to only include those meeting confidence threshold.
    pub fn filter_by_confidence(
        &self,
        extractions: Vec<MemoryExtraction>,
    ) -> Vec<MemoryExtraction> {
        let threshold = self.config.long_term_confidence_threshold.max(0.85);
        extractions
            .into_iter()
            .filter(|e| e.confidence >= threshold)
            .collect()
    }
}

#[async_trait]
impl MemoryEvaluator for LongTermExtractionEvaluator {
    fn name(&self) -> &'static str {
        "LONG_TERM_MEMORY_EXTRACTION"
    }

    fn description(&self) -> &'static str {
        "Extracts long-term facts about users from conversations"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec!["MEMORY_EXTRACTION", "FACT_LEARNING", "USER_PROFILING"]
    }

    async fn validate(&self, context: &EvaluatorContext) -> bool {
        if context.entity_id == context.agent_id {
            return false;
        }

        if context.message_text.is_empty() {
            return false;
        }

        let last_checkpoint = context
            .state
            .get("lastExtractionCheckpoint")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32)
            .unwrap_or(0);

        self.should_extract(context.message_count, last_checkpoint)
    }

    async fn handler(&self, context: &EvaluatorContext) -> Option<EvaluatorResult> {
        info!(
            "Extracting long-term memories for entity {}",
            context.entity_id
        );

        debug!(
            "Long-term extraction evaluator triggered for entity {} with {} messages",
            context.entity_id, context.message_count
        );

        Some(EvaluatorResult {
            success: true,
            data: Some(serde_json::json!({
                "evaluator": self.name(),
                "entity_id": context.entity_id.to_string(),
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
    fn test_parse_memory_extraction_xml() {
        let xml = r#"
            <memories>
                <memory>
                    <category>semantic</category>
                    <content>User is a Rust developer</content>
                    <confidence>0.95</confidence>
                </memory>
                <memory>
                    <category>episodic</category>
                    <content>User mentioned working on a CLI tool</content>
                    <confidence>0.88</confidence>
                </memory>
            </memories>
        "#;

        let extractions = parse_memory_extraction_xml(xml);
        assert_eq!(extractions.len(), 2);

        assert_eq!(extractions[0].category, LongTermMemoryCategory::Semantic);
        assert_eq!(extractions[0].content, "User is a Rust developer");
        assert!((extractions[0].confidence - 0.95).abs() < f64::EPSILON);

        assert_eq!(extractions[1].category, LongTermMemoryCategory::Episodic);
        assert_eq!(
            extractions[1].content,
            "User mentioned working on a CLI tool"
        );
        assert!((extractions[1].confidence - 0.88).abs() < f64::EPSILON);
    }

    #[test]
    fn test_should_extract() {
        let config = MemoryConfig {
            long_term_extraction_enabled: true,
            long_term_extraction_threshold: 30,
            long_term_extraction_interval: 10,
            ..Default::default()
        };

        let evaluator = LongTermExtractionEvaluator::new(config);

        // Below threshold
        assert!(!evaluator.should_extract(20, 0));

        // At threshold, first extraction
        assert!(evaluator.should_extract(30, 0));

        // At threshold, already extracted
        assert!(!evaluator.should_extract(30, 30));

        // Next interval
        assert!(evaluator.should_extract(40, 30));
    }

    #[test]
    fn test_filter_by_confidence() {
        let config = MemoryConfig {
            long_term_confidence_threshold: 0.85,
            ..Default::default()
        };

        let evaluator = LongTermExtractionEvaluator::new(config);

        let extractions = vec![
            MemoryExtraction {
                category: LongTermMemoryCategory::Semantic,
                content: "High confidence".to_string(),
                confidence: 0.95,
                metadata: serde_json::json!({}),
            },
            MemoryExtraction {
                category: LongTermMemoryCategory::Semantic,
                content: "Low confidence".to_string(),
                confidence: 0.75,
                metadata: serde_json::json!({}),
            },
            MemoryExtraction {
                category: LongTermMemoryCategory::Episodic,
                content: "Threshold confidence".to_string(),
                confidence: 0.85,
                metadata: serde_json::json!({}),
            },
        ];

        let filtered = evaluator.filter_by_confidence(extractions);
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].content, "High confidence");
        assert_eq!(filtered[1].content, "Threshold confidence");
    }
}
