//! Configuration for the Memory Plugin.

use serde::{Deserialize, Serialize};

/// Configuration for memory plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    // Short-term memory settings
    /// Messages count before summarization
    pub short_term_summarization_threshold: i32,
    /// Number of recent messages to keep after summarization
    pub short_term_retain_recent: i32,
    /// Update summary every N messages after threshold
    pub short_term_summarization_interval: i32,

    // Long-term memory settings
    /// Enable long-term memory extraction
    pub long_term_extraction_enabled: bool,
    /// Enable vector search for long-term memories
    pub long_term_vector_search_enabled: bool,
    /// Minimum confidence to store
    pub long_term_confidence_threshold: f64,
    /// Minimum messages before starting extraction
    pub long_term_extraction_threshold: i32,
    /// Run extraction every N messages after threshold
    pub long_term_extraction_interval: i32,

    // Summarization settings
    /// Model type for summarization
    pub summary_model_type: String,
    /// Maximum tokens for summary
    pub summary_max_tokens: i32,
    /// Maximum new messages per update
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
    /// Create a new config from environment variables.
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


