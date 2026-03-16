//! Integration tests for memory plugin.

use elizaos_plugin_memory::types::{
    decode_memory_text, encode_memory_text, ActionResult, MemoryImportance, ProviderResult,
};

#[test]
fn test_memory_importance_display() {
    assert_eq!(format!("{}", MemoryImportance::Low), "low");
    assert_eq!(format!("{}", MemoryImportance::Normal), "normal");
    assert_eq!(format!("{}", MemoryImportance::High), "high");
    assert_eq!(format!("{}", MemoryImportance::Critical), "critical");
}

#[test]
fn test_memory_importance_try_from() {
    assert_eq!(
        MemoryImportance::try_from(1u8).unwrap(),
        MemoryImportance::Low
    );
    assert_eq!(
        MemoryImportance::try_from(2u8).unwrap(),
        MemoryImportance::Normal
    );
    assert_eq!(
        MemoryImportance::try_from(3u8).unwrap(),
        MemoryImportance::High
    );
    assert_eq!(
        MemoryImportance::try_from(4u8).unwrap(),
        MemoryImportance::Critical
    );
    assert!(MemoryImportance::try_from(0u8).is_err());
    assert!(MemoryImportance::try_from(5u8).is_err());
}

#[test]
fn test_memory_importance_default() {
    assert_eq!(MemoryImportance::default(), MemoryImportance::Normal);
}

#[test]
fn test_encode_decode_memory_roundtrip() {
    let content = "My favorite color is blue";
    let tags = vec!["preference".to_string(), "color".to_string()];
    let importance = MemoryImportance::High;

    let encoded = encode_memory_text(content, &tags, importance);
    let decoded = decode_memory_text(&encoded);

    assert_eq!(decoded.content, content);
    assert_eq!(decoded.tags, tags);
    assert_eq!(decoded.importance, importance);
}

#[test]
fn test_decode_plain_text() {
    let text = "Just some plain text without metadata";
    let decoded = decode_memory_text(text);

    assert_eq!(decoded.content, text);
    assert!(decoded.tags.is_empty());
    assert_eq!(decoded.importance, MemoryImportance::Normal);
}

#[test]
fn test_decode_malformed_metadata() {
    let text = "not-valid-json\n---\nactual content";
    let decoded = decode_memory_text(text);

    // Falls back to treating entire string as content
    assert_eq!(decoded.content, text);
    assert!(decoded.tags.is_empty());
    assert_eq!(decoded.importance, MemoryImportance::Normal);
}

#[test]
fn test_encode_empty_tags() {
    let encoded = encode_memory_text("test content", &[], MemoryImportance::Low);
    let decoded = decode_memory_text(&encoded);

    assert_eq!(decoded.content, "test content");
    assert!(decoded.tags.is_empty());
    assert_eq!(decoded.importance, MemoryImportance::Low);
}

#[test]
fn test_encode_all_importance_levels() {
    for importance in [
        MemoryImportance::Low,
        MemoryImportance::Normal,
        MemoryImportance::High,
        MemoryImportance::Critical,
    ] {
        let encoded = encode_memory_text("test", &[], importance);
        let decoded = decode_memory_text(&encoded);
        assert_eq!(decoded.importance, importance);
    }
}

#[test]
fn test_encode_special_characters() {
    let content = "Content with \"quotes\" and\nnewlines and {braces}";
    let tags = vec!["special".to_string()];
    let encoded = encode_memory_text(content, &tags, MemoryImportance::Normal);
    let decoded = decode_memory_text(&encoded);
    assert_eq!(decoded.content, content);
    assert_eq!(decoded.tags, tags);
}

#[test]
fn test_action_result_success() {
    let result = ActionResult::success("Memory stored");
    assert!(result.success);
    assert_eq!(result.text, "Memory stored");
    assert!(result.data.is_none());
}

#[test]
fn test_action_result_success_with_data() {
    let data = serde_json::json!({"content": "test memory"});
    let result = ActionResult::success_with_data("Stored", data);
    assert!(result.success);
    assert_eq!(result.text, "Stored");
    assert!(result.data.is_some());
}

#[test]
fn test_action_result_error() {
    let result = ActionResult::error("Failed to store");
    assert!(!result.success);
    assert_eq!(result.text, "Failed to store");
    assert!(result.data.is_none());
}

#[test]
fn test_provider_result_new() {
    let result = ProviderResult::new("No memories");
    assert_eq!(result.text, "No memories");
    assert!(result.data.is_none());
}

#[test]
fn test_provider_result_with_data() {
    let data = serde_json::json!({"count": 5});
    let result = ProviderResult::with_data("Found memories", data);
    assert_eq!(result.text, "Found memories");
    assert!(result.data.is_some());
}

#[test]
fn test_memory_importance_serialization() {
    let importance = MemoryImportance::High;
    let json = serde_json::to_string(&importance).unwrap();
    assert_eq!(json, "\"High\"");

    let deserialized: MemoryImportance = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized, MemoryImportance::High);
}

#[tokio::test]
async fn test_remember_action() {
    let params = serde_json::json!({
        "content": "Test memory content",
        "tags": ["test", "unit"],
        "importance": 3,
    });

    let result = elizaos_plugin_memory::actions::remember(params).await.unwrap();
    assert!(result.success);
    assert!(result.text.contains("Remembered"));
    assert!(result.text.contains("Test memory content"));
}

#[tokio::test]
async fn test_remember_action_missing_content() {
    let params = serde_json::json!({});
    let result = elizaos_plugin_memory::actions::remember(params).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_recall_action_no_memories() {
    let params = serde_json::json!({
        "query": "test",
        "memories": [],
    });

    let result = elizaos_plugin_memory::actions::recall(params).await.unwrap();
    assert!(result.success);
    assert!(result.text.contains("No stored memories"));
}

#[tokio::test]
async fn test_recall_action_with_matching_memories() {
    let encoded = encode_memory_text("Favorite color is blue", &["preference".to_string()], MemoryImportance::Normal);
    let params = serde_json::json!({
        "query": "color",
        "memories": [
            {
                "id": "mem-1",
                "text": encoded,
                "source": "plugin-memory",
                "createdAt": "2024-01-01T00:00:00Z",
            }
        ],
    });

    let result = elizaos_plugin_memory::actions::recall(params).await.unwrap();
    assert!(result.success);
    assert!(result.text.contains("Found 1 memory"));
}

#[tokio::test]
async fn test_forget_action_by_id() {
    let params = serde_json::json!({
        "memoryId": "mem-123",
    });

    let result = elizaos_plugin_memory::actions::forget(params).await.unwrap();
    assert!(result.success);
    assert!(result.text.contains("mem-123"));
}

#[tokio::test]
async fn test_forget_action_by_content() {
    let params = serde_json::json!({
        "content": "favorite color",
    });

    let result = elizaos_plugin_memory::actions::forget(params).await.unwrap();
    assert!(result.success);
    assert!(result.text.contains("favorite color"));
}

#[tokio::test]
async fn test_forget_action_missing_params() {
    let params = serde_json::json!({});
    let result = elizaos_plugin_memory::actions::forget(params).await;
    assert!(result.is_err());
}

#[test]
fn test_memory_context_provider_empty() {
    let memories: Vec<serde_json::Value> = vec![];
    let result = elizaos_plugin_memory::providers::get_memory_context(&memories).unwrap();
    assert!(result.text.contains("No stored memories"));
}

#[test]
fn test_memory_context_provider_with_memories() {
    let encoded = encode_memory_text("Important fact", &["test".to_string()], MemoryImportance::High);
    let memories = vec![serde_json::json!({
        "id": "mem-1",
        "text": encoded,
        "source": "plugin-memory",
        "createdAt": 1000,
    })];

    let result = elizaos_plugin_memory::providers::get_memory_context(&memories).unwrap();
    assert!(result.text.contains("Stored Memories (1)"));
    assert!(result.text.contains("Important fact"));
}

#[test]
fn test_plugin_metadata() {
    let plugin = elizaos_plugin_memory::MemoryPlugin::new();
    assert_eq!(plugin.name, "@elizaos/plugin-memory-rs");
    assert!(!plugin.description.is_empty());
    assert_eq!(
        elizaos_plugin_memory::MemoryPlugin::actions(),
        vec!["REMEMBER", "RECALL", "FORGET"]
    );
    assert_eq!(
        elizaos_plugin_memory::MemoryPlugin::providers(),
        vec!["MEMORY_CONTEXT"]
    );
}
