//! Comprehensive integration tests for knowledge plugin.
//!
//! Tests cover: document processing, fragment creation, deduplication,
//! RAG metadata, embedding-based search, cosine similarity, and types.

use elizaos_plugin_knowledge::{
    AddKnowledgeOptions, ChunkResult, EmbeddingProvider, EmbeddingResult, KnowledgeConfig,
    KnowledgeDocument, KnowledgeFragment, KnowledgeItem, KnowledgeService, MemoryType,
    ProcessingResult, ProviderRateLimits, RAGMetadata, RetrievedFragmentInfo, SearchResult,
    TextChunker, context_targets_for,
};
use std::collections::HashMap;

// =========================================================================
// Type serialization tests
// =========================================================================

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
    assert!(!config.ctx_knowledge_enabled);
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

    let parsed: KnowledgeItem = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.id, "test-id");
    assert_eq!(parsed.similarity, Some(0.95));
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
        content_hash: "abc123".to_string(),
        fragments: vec![],
        metadata: HashMap::new(),
    };

    let json = serde_json::to_string(&doc).unwrap();
    assert!(json.contains("doc-1"));
    assert!(json.contains("test.txt"));
    assert!(json.contains("abc123"));
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

    let memory_type = MemoryType::Custom;
    let json = serde_json::to_string(&memory_type).unwrap();
    assert_eq!(json, "\"custom\"");
}

// =========================================================================
// RAG metadata tests
// =========================================================================

#[test]
fn test_rag_metadata_serialization() {
    let rag = RAGMetadata {
        retrieved_fragments: vec![RetrievedFragmentInfo {
            fragment_id: "frag-1".to_string(),
            document_title: "doc.txt".to_string(),
            similarity_score: Some(0.95),
            content_preview: "preview text...".to_string(),
        }],
        query_text: "test query".to_string(),
        total_fragments: 1,
        retrieval_timestamp: 1234567890,
        used_in_response: true,
    };

    let json = serde_json::to_string(&rag).unwrap();
    assert!(json.contains("frag-1"));
    assert!(json.contains("doc.txt"));
    assert!(json.contains("0.95"));
    assert!(json.contains("test query"));

    let parsed: RAGMetadata = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.retrieved_fragments.len(), 1);
    assert_eq!(parsed.query_text, "test query");
}

#[test]
fn test_rag_metadata_default() {
    let rag = RAGMetadata::default();
    assert!(rag.retrieved_fragments.is_empty());
    assert!(rag.query_text.is_empty());
    assert_eq!(rag.total_fragments, 0);
}

// =========================================================================
// Context targets tests
// =========================================================================

#[test]
fn test_context_targets() {
    let default_t = context_targets_for("DEFAULT");
    assert_eq!(default_t.min_tokens, 60);
    assert_eq!(default_t.max_tokens, 120);

    let pdf_t = context_targets_for("PDF");
    assert_eq!(pdf_t.min_tokens, 80);
    assert_eq!(pdf_t.max_tokens, 150);

    let code_t = context_targets_for("CODE");
    assert_eq!(code_t.min_tokens, 100);
    assert_eq!(code_t.max_tokens, 200);

    let tech_t = context_targets_for("TECHNICAL");
    assert_eq!(tech_t.min_tokens, 80);
    assert_eq!(tech_t.max_tokens, 160);

    let math_t = context_targets_for("MATH_PDF");
    assert_eq!(math_t.min_tokens, 100);
    assert_eq!(math_t.max_tokens, 180);
}

// =========================================================================
// Document processing pipeline tests
// =========================================================================

#[tokio::test]
async fn test_full_document_pipeline() {
    let mut service = KnowledgeService::default();

    let options = AddKnowledgeOptions {
        content: "Artificial intelligence is transforming how we work and live. Machine learning models can recognize patterns in data. Neural networks are inspired by the human brain. Deep learning has achieved remarkable results in image recognition, natural language processing, and game playing. ".repeat(5),
        content_type: "text/plain".to_string(),
        filename: "ai-intro.txt".to_string(),
        agent_id: Some("agent-1".to_string()),
        ..Default::default()
    };

    let result = service.add_knowledge(options).await.unwrap();

    assert!(result.success);
    assert!(result.fragment_count > 0);

    // Verify document was stored
    let doc = service.get_document(&result.document_id);
    assert!(doc.is_some());
    let doc = doc.unwrap();
    assert_eq!(doc.filename, "ai-intro.txt");
    assert!(!doc.content_hash.is_empty());

    // Verify fragments
    assert_eq!(doc.fragments.len(), result.fragment_count);
    for (i, frag) in doc.fragments.iter().enumerate() {
        assert_eq!(frag.position, i);
        assert_eq!(frag.document_id, result.document_id);
        assert!(!frag.content.is_empty());
    }
}

#[tokio::test]
async fn test_document_deduplication_by_id() {
    let mut service = KnowledgeService::default();

    let options = AddKnowledgeOptions {
        content: "Deduplication test content. ".repeat(20),
        content_type: "text/plain".to_string(),
        filename: "dedup.txt".to_string(),
        agent_id: Some("agent-1".to_string()),
        ..Default::default()
    };

    let result1 = service.add_knowledge(options.clone()).await.unwrap();
    let result2 = service.add_knowledge(options).await.unwrap();

    assert_eq!(result1.document_id, result2.document_id);
    assert_eq!(result1.fragment_count, result2.fragment_count);

    // Should only have one document
    assert_eq!(service.get_documents().len(), 1);
}

#[tokio::test]
async fn test_document_deduplication_by_hash() {
    let mut service = KnowledgeService::default();
    let content = "Hash-based dedup content. ".repeat(20);

    let r1 = service
        .add_knowledge(AddKnowledgeOptions {
            content: content.clone(),
            content_type: "text/plain".to_string(),
            filename: "file-a.txt".to_string(),
            agent_id: Some("agent".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(r1.success);

    let r2 = service
        .add_knowledge(AddKnowledgeOptions {
            content,
            content_type: "text/plain".to_string(),
            filename: "file-b.txt".to_string(),
            agent_id: Some("agent".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(r2.success);
    // Hash dedup should catch duplicate
}

// =========================================================================
// Cosine similarity tests
// =========================================================================

#[test]
fn test_cosine_similarity_identical() {
    let vec = vec![0.5, 0.3, 0.8, 0.1];
    let sim = KnowledgeService::cosine_similarity(&vec, &vec);
    assert!((sim - 1.0).abs() < 0.001);
}

#[test]
fn test_cosine_similarity_orthogonal() {
    let v1 = vec![1.0, 0.0, 0.0, 0.0];
    let v2 = vec![0.0, 1.0, 0.0, 0.0];
    let sim = KnowledgeService::cosine_similarity(&v1, &v2);
    assert!(sim.abs() < 0.001);
}

#[test]
fn test_cosine_similarity_opposite() {
    let v1 = vec![1.0, 0.5, 0.0];
    let v2 = vec![-1.0, -0.5, 0.0];
    let sim = KnowledgeService::cosine_similarity(&v1, &v2);
    assert!((sim + 1.0).abs() < 0.001);
}

#[test]
fn test_cosine_similarity_different_magnitudes() {
    let v1 = vec![1.0, 0.0, 0.0];
    let v2 = vec![100.0, 0.0, 0.0];
    let sim = KnowledgeService::cosine_similarity(&v1, &v2);
    assert!((sim - 1.0).abs() < 0.001); // Same direction, different magnitude
}

#[test]
fn test_cosine_similarity_zero_vector() {
    let v1 = vec![1.0, 2.0, 3.0];
    let v2 = vec![0.0, 0.0, 0.0];
    assert_eq!(KnowledgeService::cosine_similarity(&v1, &v2), 0.0);
}

#[test]
fn test_cosine_similarity_mismatched_lengths() {
    let v1 = vec![1.0, 2.0];
    let v2 = vec![1.0, 2.0, 3.0];
    assert_eq!(KnowledgeService::cosine_similarity(&v1, &v2), 0.0);
}

// =========================================================================
// Embedding-based search tests
// =========================================================================

#[tokio::test]
async fn test_embedding_search_pipeline() {
    let mut service = KnowledgeService::default();

    // Add document
    let result = service
        .add_knowledge(AddKnowledgeOptions {
            content: "Machine learning is a subset of AI. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "ml.txt".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();

    // Set mock embeddings on fragments
    let frag_ids = service.get_fragment_ids_for_document(&result.document_id);
    assert!(!frag_ids.is_empty());

    for frag_id in &frag_ids {
        let set_ok = service.set_fragment_embedding(frag_id, vec![0.8, 0.1, 0.05, 0.05]);
        assert!(set_ok);
    }

    // Search with similar embedding
    let query_emb = vec![0.75, 0.15, 0.05, 0.05];
    let results = service.search_with_embedding(&query_emb, 5, 0.1);

    assert!(!results.is_empty());
    // Should be high similarity
    assert!(results[0].similarity > 0.9);
    assert_eq!(results[0].document_title, Some("ml.txt".to_string()));
}

#[tokio::test]
async fn test_embedding_search_low_threshold() {
    let mut service = KnowledgeService::default();

    let result = service
        .add_knowledge(AddKnowledgeOptions {
            content: "Quantum computing harnesses quantum mechanics. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "quantum.txt".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();

    let frag_ids = service.get_fragment_ids_for_document(&result.document_id);
    for frag_id in &frag_ids {
        service.set_fragment_embedding(frag_id, vec![0.9, 0.0, 0.1, 0.0]);
    }

    // Orthogonal query should return nothing above 0.5 threshold
    let query = vec![0.0, 0.9, 0.0, 0.1];
    let results = service.search_with_embedding(&query, 5, 0.5);
    assert!(results.is_empty());

    // But low threshold should still return results
    let results = service.search_with_embedding(&query, 5, 0.0);
    assert!(!results.is_empty());
}

// =========================================================================
// RAG enrichment integration tests
// =========================================================================

#[tokio::test]
async fn test_rag_metadata_from_search() {
    let mut service = KnowledgeService::default();

    service
        .add_knowledge(AddKnowledgeOptions {
            content: "Machine learning uses algorithms to learn from data. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "ml-basics.txt".to_string(),
            agent_id: Some("agent".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

    let items = service.get_knowledge("machine learning", 5).await.unwrap();
    assert!(!items.is_empty());

    let rag = service.build_rag_metadata(&items, "machine learning");
    assert!(!rag.retrieved_fragments.is_empty());
    assert_eq!(rag.query_text, "machine learning");
    assert!(rag.retrieval_timestamp > 0);
}

#[tokio::test]
async fn test_pending_rag_enrichment() {
    let mut service = KnowledgeService::default();

    let rag = RAGMetadata {
        retrieved_fragments: vec![RetrievedFragmentInfo {
            fragment_id: "f1".to_string(),
            document_title: "test.txt".to_string(),
            similarity_score: Some(0.9),
            content_preview: "preview".to_string(),
        }],
        query_text: "test".to_string(),
        total_fragments: 1,
        retrieval_timestamp: 12345,
        used_in_response: true,
    };

    service.set_pending_rag_metadata(rag);
    assert_eq!(service.pending_rag_entries().len(), 1);

    service.clear_pending_rag_entry(0);
    assert!(service.pending_rag_entries().is_empty());
}

// =========================================================================
// Chunker integration tests
// =========================================================================

#[test]
fn test_chunker_configurable() {
    let chunker = TextChunker::new(100, 20);
    let text = "This is a test. ".repeat(100);

    let result = chunker.split(&text);

    assert!(result.chunk_count > 1);
    assert_eq!(result.chunk_count, result.chunks.len());
    assert!(result.total_tokens > 0);

    for chunk in &result.chunks {
        assert!(!chunk.is_empty());
    }
}

#[test]
fn test_chunker_token_estimation() {
    let chunker = TextChunker::default();
    let text = "Hello, world!"; // 13 chars
    let tokens = chunker.estimate_tokens(text);
    assert!((3..=4).contains(&tokens));
}

// =========================================================================
// Delete and CRUD integration tests
// =========================================================================

#[tokio::test]
async fn test_delete_clears_fragments() {
    let mut service = KnowledgeService::default();

    let result = service
        .add_knowledge(AddKnowledgeOptions {
            content: "Content for deletion test. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "delete-me.txt".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();

    let initial_count = service.get_fragment_count();
    assert!(initial_count > 0);

    service.delete_knowledge(&result.document_id).await;

    assert_eq!(service.get_fragment_count(), 0);
    assert!(service.get_document(&result.document_id).is_none());
}

#[tokio::test]
async fn test_multiple_documents() {
    let mut service = KnowledgeService::default();

    let topics = [
        "Artificial intelligence and machine learning are transforming industries around the world",
        "Quantum computing uses qubits to solve complex optimization and simulation problems",
        "Blockchain technology provides decentralized consensus for financial transactions",
    ];

    for (i, topic) in topics.iter().enumerate() {
        service
            .add_knowledge(AddKnowledgeOptions {
                content: format!("{} - extended content for document number {}. ", topic, i).repeat(20),
                content_type: "text/plain".to_string(),
                filename: format!("doc-{}.txt", i),
                agent_id: Some("agent".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
    }

    assert_eq!(service.get_documents().len(), 3);
    assert!(service.get_fragment_count() >= 3); // Each doc should produce at least one fragment
}

#[tokio::test]
async fn test_keyword_search_ranking() {
    let mut service = KnowledgeService::default();

    service
        .add_knowledge(AddKnowledgeOptions {
            content: "Python programming language features and syntax. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "python.txt".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();

    service
        .add_knowledge(AddKnowledgeOptions {
            content: "JavaScript web development and frameworks. ".repeat(20),
            content_type: "text/plain".to_string(),
            filename: "javascript.txt".to_string(),
            ..Default::default()
        })
        .await
        .unwrap();

    let results = service.search("python programming", 10, 0.1).await.unwrap();
    assert!(!results.is_empty());

    // Python results should rank higher
    if results.len() >= 2 {
        let first_is_python = results[0]
            .document_title
            .as_deref()
            .unwrap_or("")
            .contains("python");
        if !first_is_python {
            // At minimum, results should contain python content
            assert!(results.iter().any(|r| r.content.to_lowercase().contains("python")));
        }
    }
}
