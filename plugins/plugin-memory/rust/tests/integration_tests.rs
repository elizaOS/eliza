//! Integration tests for the Memory Plugin.

use elizaos_plugin_memory::{
    LongTermMemoryCategory, MemoryConfig, MemoryService,
};

#[test]
fn test_config_defaults() {
    let config = MemoryConfig::default();
    
    assert_eq!(config.short_term_summarization_threshold, 16);
    assert_eq!(config.short_term_retain_recent, 6);
    assert_eq!(config.short_term_summarization_interval, 10);
    assert!(config.long_term_extraction_enabled);
    assert!(!config.long_term_vector_search_enabled);
    assert!((config.long_term_confidence_threshold - 0.85).abs() < f64::EPSILON);
    assert_eq!(config.long_term_extraction_threshold, 30);
    assert_eq!(config.long_term_extraction_interval, 10);
}

#[test]
fn test_memory_category_display() {
    assert_eq!(LongTermMemoryCategory::Episodic.to_string(), "episodic");
    assert_eq!(LongTermMemoryCategory::Semantic.to_string(), "semantic");
    assert_eq!(LongTermMemoryCategory::Procedural.to_string(), "procedural");
}

#[test]
fn test_memory_category_from_str() {
    assert_eq!(
        "episodic".parse::<LongTermMemoryCategory>().unwrap(),
        LongTermMemoryCategory::Episodic
    );
    assert_eq!(
        "semantic".parse::<LongTermMemoryCategory>().unwrap(),
        LongTermMemoryCategory::Semantic
    );
    assert_eq!(
        "procedural".parse::<LongTermMemoryCategory>().unwrap(),
        LongTermMemoryCategory::Procedural
    );
    assert!("invalid".parse::<LongTermMemoryCategory>().is_err());
}

#[tokio::test]
async fn test_memory_service_creation() {
    let config = MemoryConfig::default();
    let service = MemoryService::new(config);
    
    let retrieved_config = service.get_config().await;
    assert_eq!(retrieved_config.short_term_summarization_threshold, 16);
}

#[tokio::test]
async fn test_message_count_tracking() {
    let config = MemoryConfig::default();
    let service = MemoryService::new(config);
    
    let room_id = uuid::Uuid::new_v4();
    
    let count1 = service.increment_message_count(room_id).await;
    let count2 = service.increment_message_count(room_id).await;
    let count3 = service.increment_message_count(room_id).await;
    
    assert_eq!(count1, 1);
    assert_eq!(count2, 2);
    assert_eq!(count3, 3);
    
    service.reset_message_count(room_id).await;
    let count4 = service.increment_message_count(room_id).await;
    assert_eq!(count4, 1);
}







