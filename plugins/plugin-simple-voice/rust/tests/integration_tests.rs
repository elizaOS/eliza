//! Integration tests for simple-voice plugin.

use eliza_plugin_simple_voice::{
    SamTTSOptions, DEFAULT_SAM_OPTIONS, SPEECH_TRIGGERS, VOCALIZATION_PATTERNS,
};
use eliza_plugin_simple_voice::types::{
    SAM_SERVICE_TYPE, MemoryContent, Memory, CallbackResult,
};
use std::collections::HashMap;

#[test]
fn test_sam_tts_options_default() {
    let options = SamTTSOptions::default();
    assert_eq!(options.speed, 72);
    assert_eq!(options.pitch, 64);
    assert_eq!(options.throat, 128);
    assert_eq!(options.mouth, 128);
}

#[test]
fn test_default_sam_options_constant() {
    assert_eq!(DEFAULT_SAM_OPTIONS.speed, 72);
    assert_eq!(DEFAULT_SAM_OPTIONS.pitch, 64);
    assert_eq!(DEFAULT_SAM_OPTIONS.throat, 128);
    assert_eq!(DEFAULT_SAM_OPTIONS.mouth, 128);
}

#[test]
fn test_sam_service_type_constant() {
    assert_eq!(SAM_SERVICE_TYPE, "SAM_TTS");
}

#[test]
fn test_speech_triggers_not_empty() {
    assert!(!SPEECH_TRIGGERS.is_empty());
    assert!(SPEECH_TRIGGERS.contains(&"speak"));
    assert!(SPEECH_TRIGGERS.contains(&"say aloud"));
}

#[test]
fn test_vocalization_patterns_not_empty() {
    assert!(!VOCALIZATION_PATTERNS.is_empty());
    assert!(VOCALIZATION_PATTERNS.contains(&"can you say"));
}

#[test]
fn test_sam_tts_options_serialization() {
    let options = SamTTSOptions {
        speed: 100,
        pitch: 80,
        throat: 150,
        mouth: 160,
    };
    
    let json = serde_json::to_string(&options).unwrap();
    assert!(json.contains("100"));
    assert!(json.contains("80"));
    
    let parsed: SamTTSOptions = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.speed, 100);
    assert_eq!(parsed.pitch, 80);
}

#[test]
fn test_memory_content_serialization() {
    let mut extra = HashMap::new();
    extra.insert("key".to_string(), serde_json::json!("value"));
    
    let content = MemoryContent {
        text: "Hello world".to_string(),
        extra,
    };
    
    let json = serde_json::to_string(&content).unwrap();
    assert!(json.contains("Hello world"));
    assert!(json.contains("key"));
}

#[test]
fn test_memory_serialization() {
    let memory = Memory {
        id: "mem-1".to_string(),
        entity_id: "entity-1".to_string(),
        agent_id: "agent-1".to_string(),
        room_id: "room-1".to_string(),
        content: MemoryContent {
            text: "Test memory".to_string(),
            extra: HashMap::new(),
        },
        created_at: 1234567890,
    };
    
    let json = serde_json::to_string(&memory).unwrap();
    assert!(json.contains("mem-1"));
    assert!(json.contains("agent-1"));
    assert!(json.contains("Test memory"));
}

#[test]
fn test_callback_result_serialization() {
    let result = CallbackResult {
        text: "Action completed".to_string(),
        action: "speak".to_string(),
        audio_data: Some(vec![0, 1, 2, 3]),
    };
    
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("Action completed"));
    assert!(json.contains("speak"));
}

#[test]
fn test_callback_result_without_audio() {
    let result = CallbackResult {
        text: "Action completed".to_string(),
        action: "speak".to_string(),
        audio_data: None,
    };
    
    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("Action completed"));
    assert!(!json.contains("audio_data"));
}
