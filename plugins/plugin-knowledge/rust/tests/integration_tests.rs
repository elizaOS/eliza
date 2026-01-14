//! Integration tests for knowledge plugin.

use elizaos_plugin_knowledge::{
    AddKnowledgeOptions, ChunkResult, EmbeddingProvider, EmbeddingResult, KnowledgeConfig,
    KnowledgeDocument, KnowledgeFragment, KnowledgeItem, MemoryType, ProcessingResult,
    ProviderRateLimits, SearchResult,
};
use std::collections::HashMap;

#[test]
fn test_knowledge_config_default() {
    let config = KnowledgeConfig::default();
    assert_eq!(config.embedding_provider, "openai");
    assert_eq!(config.embedding_model, "text-embedding-3-small");
    assert_eq!(config.embedding_dimension, 1536);
    assert_eq!(config.chunk_size, 500);
    assert_eq!(config.chunk_overlap, 100);
    assert!(config.rate_limit_enabled);
    assert_eq!(config.max_concurrent_requests, 30);
    assert_eq!(config.requests_per_minute, 60);
    assert_eq!(config.tokens_per_minute, 150000);
}

#[test]
fn test_embedding_provider_default() {
    let provider = EmbeddingProvider::default();
    assert_eq!(provider, EmbeddingProvider::OpenAI);
}

#[test]
fn test_knowledge_item_serialization() {
    let item = KnowledgeItem {
        id: "test-id".to_string(),
        content: "Test content".to_string(),
        metadata: HashMap::new(),
        embedding: Some(vec![0.1, 0.2, 0.3]),
        similarity: Some(0.95),
    };

    let json = serde_json::to_string(&item).unwrap();
    assert!(json.contains("test-id"));
    assert!(json.contains("Test content"));
}

#[test]
fn test_knowledge_fragment_serialization() {
    let fragment = KnowledgeFragment {
        id: "frag-1".to_string(),
        document_id: "doc-1".to_string(),
        content: "Fragment content".to_string(),
        position: 0,
        embedding: None,
        metadata: HashMap::new(),
    };

    let json = serde_json::to_string(&fragment).unwrap();
    assert!(json.contains("frag-1"));
    assert!(json.contains("doc-1"));
}

#[test]
fn test_knowledge_document_serialization() {
    let doc = KnowledgeDocument {
        id: "doc-1".to_string(),
        content: "Full document content".to_string(),
        filename: "test.txt".to_string(),
        content_type: "text/plain".to_string(),
        file_size: 100,
        fragments: vec![],
        metadata: HashMap::new(),
    };

    let json = serde_json::to_string(&doc).unwrap();
    assert!(json.contains("doc-1"));
    assert!(json.contains("test.txt"));
}

#[test]
fn test_embedding_result_serialization() {
    let result = EmbeddingResult {
        embedding: vec![0.1, 0.2, 0.3],
        tokens_used: 10,
        model: "text-embedding-3-small".to_string(),
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("text-embedding-3-small"));
}

#[test]
fn test_search_result_serialization() {
    let result = SearchResult {
        id: "result-1".to_string(),
        content: "Search result content".to_string(),
        similarity: 0.95,
        document_id: Some("doc-1".to_string()),
        document_title: Some("Test Doc".to_string()),
        metadata: HashMap::new(),
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("result-1"));
    assert!(json.contains("0.95"));
}

#[test]
fn test_add_knowledge_options_default() {
    let options = AddKnowledgeOptions::default();
    assert!(options.content.is_empty());
    assert!(options.content_type.is_empty());
    assert!(options.filename.is_empty());
    assert!(options.agent_id.is_none());
}

#[test]
fn test_provider_rate_limits_default() {
    let limits = ProviderRateLimits::default();
    assert_eq!(limits.max_concurrent_requests, 30);
    assert_eq!(limits.requests_per_minute, 60);
    assert_eq!(limits.tokens_per_minute, Some(150000));
    assert!(limits.rate_limit_enabled);
    assert_eq!(limits.batch_delay_ms, 100);
}

#[test]
fn test_chunk_result_serialization() {
    let result = ChunkResult {
        chunks: vec!["chunk1".to_string(), "chunk2".to_string()],
        total_tokens: 100,
        chunk_count: 2,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("chunk1"));
    assert!(json.contains("chunk2"));
}

#[test]
fn test_processing_result_serialization() {
    let result = ProcessingResult {
        document_id: "doc-1".to_string(),
        fragment_count: 5,
        success: true,
        error: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("doc-1"));
    assert!(json.contains("true"));
}

#[test]
fn test_memory_type_serialization() {
    let memory_type = MemoryType::Document;
    let json = serde_json::to_string(&memory_type).unwrap();
    assert_eq!(json, "\"document\"");

    let memory_type = MemoryType::Fragment;
    let json = serde_json::to_string(&memory_type).unwrap();
    assert_eq!(json, "\"fragment\"");
}
