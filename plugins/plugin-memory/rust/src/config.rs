#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    pub short_term_summarization_threshold: i32,
    pub short_term_retain_recent: i32,
    pub short_term_summarization_interval: i32,
    pub long_term_extraction_enabled: bool,
    pub long_term_vector_search_enabled: bool,
    pub long_term_confidence_threshold: f64,
    pub long_term_extraction_threshold: i32,
    pub long_term_extraction_interval: i32,
    pub summary_model_type: String,
    pub summary_max_tokens: i32,
    pub summary_max_new_messages: i32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            short_term_summarization_threshold: 16,
            short_term_retain_recent: 6,
            short_term_summarization_interval: 10,
            long_term_extraction_enabled: true,
            long_term_vector_search_enabled: false,
            long_term_confidence_threshold: 0.85,
            long_term_extraction_threshold: 30,
            long_term_extraction_interval: 10,
            summary_model_type: "TEXT_LARGE".to_string(),
            summary_max_tokens: 2500,
            summary_max_new_messages: 20,
        }
    }
}

impl MemoryConfig {
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(val) = std::env::var("MEMORY_SUMMARIZATION_THRESHOLD") {
            if let Ok(n) = val.parse() {
                config.short_term_summarization_threshold = n;
            }
        }

        if let Ok(val) = std::env::var("MEMORY_RETAIN_RECENT") {
            if let Ok(n) = val.parse() {
                config.short_term_retain_recent = n;
            }
        }

        if let Ok(val) = std::env::var("MEMORY_SUMMARIZATION_INTERVAL") {
            if let Ok(n) = val.parse() {
                config.short_term_summarization_interval = n;
            }
        }

        if let Ok(val) = std::env::var("MEMORY_MAX_NEW_MESSAGES") {
            if let Ok(n) = val.parse() {
                config.summary_max_new_messages = n;
            }
        }

        if let Ok(val) = std::env::var("MEMORY_LONG_TERM_ENABLED") {
            config.long_term_extraction_enabled = val.to_lowercase() != "false";
        }

        if let Ok(val) = std::env::var("MEMORY_CONFIDENCE_THRESHOLD") {
            if let Ok(n) = val.parse() {
                config.long_term_confidence_threshold = n;
            }
        }

        if let Ok(val) = std::env::var("MEMORY_EXTRACTION_THRESHOLD") {
            if let Ok(n) = val.parse() {
                config.long_term_extraction_threshold = n;
            }
        }

        if let Ok(val) = std::env::var("MEMORY_EXTRACTION_INTERVAL") {
            if let Ok(n) = val.parse() {
                config.long_term_extraction_interval = n;
            }
        }

        config
    }
}
