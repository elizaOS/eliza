#![allow(missing_docs)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Supported embedding providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingProvider {
    #[default]
    OpenAI,
    Google,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextProvider {
    OpenAI,
    Anthropic,
    OpenRouter,
    Google,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MemoryType {
    Document,
    Fragment,
    Message,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeConfig {
    #[serde(default = "default_embedding_provider")]
    pub embedding_provider: String,
    #[serde(default = "default_embedding_model")]
    pub embedding_model: String,
    #[serde(default = "default_embedding_dimension")]
    pub embedding_dimension: usize,
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub google_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    pub openai_base_url: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub google_base_url: Option<String>,
    pub openrouter_base_url: Option<String>,
    #[serde(default)]
    pub ctx_knowledge_enabled: bool,
    pub text_provider: Option<String>,
    pub text_model: Option<String>,
    #[serde(default = "default_max_input_tokens")]
    pub max_input_tokens: usize,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: usize,
    #[serde(default = "default_chunk_size")]
    pub chunk_size: usize,
    #[serde(default = "default_chunk_overlap")]
    pub chunk_overlap: usize,
    #[serde(default = "default_true")]
    pub rate_limit_enabled: bool,
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent_requests: usize,
    #[serde(default = "default_requests_per_minute")]
    pub requests_per_minute: usize,
    #[serde(default = "default_tokens_per_minute")]
    pub tokens_per_minute: usize,
    #[serde(default)]
    pub load_docs_on_startup: bool,
    #[serde(default = "default_knowledge_path")]
    pub knowledge_path: String,
}

fn default_embedding_provider() -> String {
    "openai".to_string()
}

fn default_embedding_model() -> String {
    "text-embedding-3-small".to_string()
}

fn default_embedding_dimension() -> usize {
    1536
}

fn default_max_input_tokens() -> usize {
    4000
}

fn default_max_output_tokens() -> usize {
    4096
}

fn default_chunk_size() -> usize {
    500
}

fn default_chunk_overlap() -> usize {
    100
}

fn default_true() -> bool {
    true
}

fn default_max_concurrent() -> usize {
    30
}

fn default_requests_per_minute() -> usize {
    60
}

fn default_tokens_per_minute() -> usize {
    150000
}

fn default_knowledge_path() -> String {
    "./docs".to_string()
}

impl Default for KnowledgeConfig {
    fn default() -> Self {
        Self {
            embedding_provider: default_embedding_provider(),
            embedding_model: default_embedding_model(),
            embedding_dimension: default_embedding_dimension(),
            openai_api_key: None,
            anthropic_api_key: None,
            google_api_key: None,
            openrouter_api_key: None,
            openai_base_url: None,
            anthropic_base_url: None,
            google_base_url: None,
            openrouter_base_url: None,
            ctx_knowledge_enabled: false,
            text_provider: None,
            text_model: None,
            max_input_tokens: default_max_input_tokens(),
            max_output_tokens: default_max_output_tokens(),
            chunk_size: default_chunk_size(),
            chunk_overlap: default_chunk_overlap(),
            rate_limit_enabled: true,
            max_concurrent_requests: default_max_concurrent(),
            requests_per_minute: default_requests_per_minute(),
            tokens_per_minute: default_tokens_per_minute(),
            load_docs_on_startup: false,
            knowledge_path: default_knowledge_path(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeItem {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
    pub embedding: Option<Vec<f32>>,
    pub similarity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeFragment {
    pub id: String,
    pub document_id: String,
    pub content: String,
    pub position: usize,
    pub embedding: Option<Vec<f32>>,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeDocument {
    pub id: String,
    pub content: String,
    pub filename: String,
    pub content_type: String,
    pub file_size: usize,
    #[serde(default)]
    pub fragments: Vec<KnowledgeFragment>,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingResult {
    pub embedding: Vec<f32>,
    #[serde(default)]
    pub tokens_used: usize,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub content: String,
    pub similarity: f64,
    pub document_id: Option<String>,
    pub document_title: Option<String>,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AddKnowledgeOptions {
    pub content: String,
    pub content_type: String,
    pub filename: String,
    pub agent_id: Option<String>,
    pub world_id: Option<String>,
    pub room_id: Option<String>,
    pub entity_id: Option<String>,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TextGenerationOptions {
    pub provider: Option<String>,
    pub model_name: Option<String>,
    pub max_tokens: Option<usize>,
    pub cache_document: Option<String>,
    #[serde(default)]
    pub cache_options: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub auto_cache_contextual_retrieval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderRateLimits {
    pub max_concurrent_requests: usize,
    pub requests_per_minute: usize,
    pub tokens_per_minute: Option<usize>,
    #[serde(default)]
    pub provider: String,
    #[serde(default = "default_true")]
    pub rate_limit_enabled: bool,
    #[serde(default = "default_batch_delay")]
    pub batch_delay_ms: u64,
}

fn default_batch_delay() -> u64 {
    100
}

impl Default for ProviderRateLimits {
    fn default() -> Self {
        Self {
            max_concurrent_requests: 30,
            requests_per_minute: 60,
            tokens_per_minute: Some(150000),
            provider: "unlimited".to_string(),
            rate_limit_enabled: true,
            batch_delay_ms: 100,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkResult {
    pub chunks: Vec<String>,
    #[serde(default)]
    pub total_tokens: usize,
    #[serde(default)]
    pub chunk_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessingResult {
    pub document_id: String,
    pub fragment_count: usize,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum KnowledgeError {
    #[error("Document not found: {0}")]
    DocumentNotFound(String),

    #[error("Failed to process document: {0}")]
    ProcessingError(String),

    #[error("Embedding generation failed: {0}")]
    EmbeddingError(String),

    #[error("Search failed: {0}")]
    SearchError(String),

    #[error("Configuration error: {0}")]
    ConfigError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, KnowledgeError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = KnowledgeConfig::default();
        assert_eq!(config.embedding_provider, "openai");
        assert_eq!(config.embedding_model, "text-embedding-3-small");
        assert_eq!(config.embedding_dimension, 1536);
        assert_eq!(config.chunk_size, 500);
        assert_eq!(config.chunk_overlap, 100);
    }

    #[test]
    fn test_config_serialization() {
        let config = KnowledgeConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: KnowledgeConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config.embedding_provider, parsed.embedding_provider);
    }

    #[test]
    fn test_add_knowledge_options_default() {
        let options = AddKnowledgeOptions::default();
        assert!(options.content.is_empty());
        assert!(options.content_type.is_empty());
        assert!(options.metadata.is_empty());
    }
}
