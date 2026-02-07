//! History processors for managing conversation history
//!
//! These processors transform the conversation history before it's sent to the model.

use crate::types::{Content, History};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Trait for history processors
pub trait HistoryProcessor: Send + Sync {
    fn process(&self, history: History) -> History;
}

/// Default history processor that passes through unchanged
pub struct DefaultHistoryProcessor;

impl HistoryProcessor for DefaultHistoryProcessor {
    fn process(&self, history: History) -> History {
        history
    }
}

/// Processor that keeps only the last N observations
pub struct LastNObservations {
    n: usize,
}

impl LastNObservations {
    pub fn new(n: usize) -> Self {
        Self { n }
    }
}

impl HistoryProcessor for LastNObservations {
    fn process(&self, history: History) -> History {
        if self.n == 0 {
            return history;
        }

        let mut result = Vec::new();
        let mut observation_count = 0;

        // Iterate in reverse to count observations from the end
        for item in history.iter().rev() {
            let is_observation = item
                .message_type
                .as_ref()
                .map(|t| matches!(t, crate::types::MessageType::Observation))
                .unwrap_or(false);

            if is_observation {
                observation_count += 1;
            }

            if observation_count <= self.n || !is_observation {
                result.push(item.clone());
            }
        }

        result.reverse();
        result
    }
}

/// Processor that wraps tool call observations in tags
pub struct TagToolCallObservations {
    tag: String,
}

impl TagToolCallObservations {
    pub fn new(tag: impl Into<String>) -> Self {
        Self { tag: tag.into() }
    }
}

impl HistoryProcessor for TagToolCallObservations {
    fn process(&self, history: History) -> History {
        history
            .into_iter()
            .map(|mut item| {
                if item.tool_call_ids.is_some() {
                    let content = item.content.as_str();
                    item.content =
                        Content::Text(format!("<{}>\n{}\n</{}>", self.tag, content, self.tag));
                }
                item
            })
            .collect()
    }
}

/// Processor that handles closed window files
pub struct ClosedWindowHistoryProcessor;

impl HistoryProcessor for ClosedWindowHistoryProcessor {
    fn process(&self, history: History) -> History {
        // Implementation would track open/closed files and adjust history
        history
    }
}

/// Processor that adds cache control headers for Anthropic
pub struct CacheControlHistoryProcessor;

impl HistoryProcessor for CacheControlHistoryProcessor {
    fn process(&self, history: History) -> History {
        // Add cache control for last few messages
        history
    }
}

/// Processor that removes content matching a regex pattern
pub struct RemoveRegex {
    pattern: Regex,
}

impl RemoveRegex {
    pub fn new(pattern: &str) -> Option<Self> {
        Regex::new(pattern).ok().map(|pattern| Self { pattern })
    }
}

impl HistoryProcessor for RemoveRegex {
    fn process(&self, history: History) -> History {
        history
            .into_iter()
            .map(|mut item| {
                let content = item.content.as_str();
                let cleaned = self.pattern.replace_all(&content, "").to_string();
                item.content = Content::Text(cleaned);
                item
            })
            .collect()
    }
}

/// Processor that handles image parsing in history
pub struct ImageParsingHistoryProcessor {
    disable_images: bool,
}

impl ImageParsingHistoryProcessor {
    pub fn new(disable_images: bool) -> Self {
        Self { disable_images }
    }
}

impl HistoryProcessor for ImageParsingHistoryProcessor {
    fn process(&self, history: History) -> History {
        if !self.disable_images {
            return history;
        }

        // Remove image content parts
        history
            .into_iter()
            .map(|mut item| {
                if let Content::Structured(parts) = &item.content {
                    let filtered: Vec<_> = parts
                        .iter()
                        .filter(|p| !matches!(p, crate::types::ContentPart::Image { .. }))
                        .cloned()
                        .collect();
                    item.content = Content::Structured(filtered);
                }
                item
            })
            .collect()
    }
}

/// Chain multiple history processors together
pub struct ChainedHistoryProcessor {
    processors: Vec<Box<dyn HistoryProcessor>>,
}

impl ChainedHistoryProcessor {
    pub fn new(processors: Vec<Box<dyn HistoryProcessor>>) -> Self {
        Self { processors }
    }
}

impl HistoryProcessor for ChainedHistoryProcessor {
    fn process(&self, mut history: History) -> History {
        for processor in &self.processors {
            history = processor.process(history);
        }
        history
    }
}

/// Configuration for history processors
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HistoryProcessorConfig {
    #[default]
    Default,
    LastNObservations { n: usize },
    TagToolCallObservations { tag: String },
    ClosedWindow,
    CacheControl,
    RemoveRegex { pattern: String },
    ImageParsing { disable_images: bool },
}

/// Create a history processor from configuration
pub fn create_history_processor(config: &HistoryProcessorConfig) -> Box<dyn HistoryProcessor> {
    match config {
        HistoryProcessorConfig::Default => Box::new(DefaultHistoryProcessor),
        HistoryProcessorConfig::LastNObservations { n } => Box::new(LastNObservations::new(*n)),
        HistoryProcessorConfig::TagToolCallObservations { tag } => {
            Box::new(TagToolCallObservations::new(tag))
        }
        HistoryProcessorConfig::ClosedWindow => Box::new(ClosedWindowHistoryProcessor),
        HistoryProcessorConfig::CacheControl => Box::new(CacheControlHistoryProcessor),
        HistoryProcessorConfig::RemoveRegex { pattern } => RemoveRegex::new(pattern)
            .map(|p| Box::new(p) as Box<dyn HistoryProcessor>)
            .unwrap_or_else(|| Box::new(DefaultHistoryProcessor)),
        HistoryProcessorConfig::ImageParsing { disable_images } => {
            Box::new(ImageParsingHistoryProcessor::new(*disable_images))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HistoryItem, MessageType, Role};

    #[test]
    fn test_default_processor() {
        let processor = DefaultHistoryProcessor;
        let history = vec![HistoryItem::user("test")];
        let result = processor.process(history.clone());
        assert_eq!(result.len(), history.len());
    }

    #[test]
    fn test_last_n_observations() {
        let processor = LastNObservations::new(2);
        let history = vec![
            HistoryItem {
                role: Role::User,
                content: Content::Text("obs1".to_string()),
                message_type: Some(MessageType::Observation),
                ..Default::default()
            },
            HistoryItem {
                role: Role::User,
                content: Content::Text("obs2".to_string()),
                message_type: Some(MessageType::Observation),
                ..Default::default()
            },
            HistoryItem {
                role: Role::User,
                content: Content::Text("obs3".to_string()),
                message_type: Some(MessageType::Observation),
                ..Default::default()
            },
        ];

        let result = processor.process(history);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_remove_regex() {
        let processor = RemoveRegex::new(r"\[DEBUG\]").unwrap();
        let history = vec![HistoryItem {
            content: Content::Text("Hello [DEBUG] world".to_string()),
            ..Default::default()
        }];

        let result = processor.process(history);
        assert_eq!(result[0].content.as_str(), "Hello  world");
    }
}
