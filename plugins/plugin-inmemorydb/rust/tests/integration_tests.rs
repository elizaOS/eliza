//! Integration tests for inmemorydb plugin.

use elizaos_plugin_inmemorydb::types::StorageError;
use elizaos_plugin_inmemorydb::{VectorSearchResult, COLLECTIONS};

#[test]
fn test_collections_constants() {
    assert_eq!(COLLECTIONS::AGENTS, "agents");
    assert_eq!(COLLECTIONS::ENTITIES, "entities");
    assert_eq!(COLLECTIONS::MEMORIES, "memories");
    assert_eq!(COLLECTIONS::ROOMS, "rooms");
    assert_eq!(COLLECTIONS::WORLDS, "worlds");
    assert_eq!(COLLECTIONS::COMPONENTS, "components");
    assert_eq!(COLLECTIONS::RELATIONSHIPS, "relationships");
    assert_eq!(COLLECTIONS::PARTICIPANTS, "participants");
    assert_eq!(COLLECTIONS::TASKS, "tasks");
    assert_eq!(COLLECTIONS::CACHE, "cache");
    assert_eq!(COLLECTIONS::LOGS, "logs");
    assert_eq!(COLLECTIONS::EMBEDDINGS, "embeddings");
}

#[test]
fn test_vector_search_result_serialization() {
    let result = VectorSearchResult {
        id: "test-id".to_string(),
        distance: 0.5,
        similarity: 0.8,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("test-id"));
    assert!(json.contains("0.5"));
    assert!(json.contains("0.8"));

    let parsed: VectorSearchResult = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.id, "test-id");
    assert!((parsed.distance - 0.5).abs() < f32::EPSILON);
    assert!((parsed.similarity - 0.8).abs() < f32::EPSILON);
}

#[test]
fn test_storage_error_display() {
    let error = StorageError::NotReady;
    assert_eq!(format!("{}", error), "Storage not ready");

    let error = StorageError::NotFound("test-item".to_string());
    assert!(format!("{}", error).contains("test-item"));

    let error = StorageError::DimensionMismatch {
        expected: 512,
        actual: 384,
    };
    assert!(format!("{}", error).contains("512"));
    assert!(format!("{}", error).contains("384"));
}

#[test]
fn test_storage_error_serialization_error() {
    let error = StorageError::Serialization("JSON parse failed".to_string());
    assert!(format!("{}", error).contains("JSON parse failed"));
}

#[test]
fn test_storage_error_other() {
    let error = StorageError::Other("Custom error".to_string());
    assert!(format!("{}", error).contains("Custom error"));
}
