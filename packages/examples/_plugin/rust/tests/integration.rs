//! Integration tests for the elizaOS Rust Plugin Starter
//!
//! These tests validate the plugin interface, JSON serialization,
//! and cross-language compatibility.

use elizaos_plugin_starter::*;

#[test]
fn test_plugin_creation() {
    let plugin = StarterPlugin::new();
    // Plugin is created successfully
    let manifest = plugin.manifest();
    assert!(manifest.is_object());
}

#[test]
fn test_plugin_initialization() {
    let mut plugin = StarterPlugin::new();
    let result = plugin.init("{}");
    assert!(result.is_ok());
    // After init, manifest should still be valid
    let manifest = plugin.manifest();
    assert_eq!(manifest["name"], "rust-plugin-starter");
}

#[test]
fn test_plugin_init_with_config() {
    let mut plugin = StarterPlugin::new();
    let config = r#"{"API_KEY": "test-key", "DEBUG": "true"}"#;
    let result = plugin.init(config);
    assert!(result.is_ok());
}

#[test]
fn test_manifest_generation() {
    let plugin = StarterPlugin::new();
    let manifest = plugin.manifest();
    
    assert!(manifest.is_object());
    assert_eq!(manifest["name"], "rust-plugin-starter");
    assert_eq!(manifest["language"], "rust");
    assert!(manifest["actions"].is_array());
    assert!(manifest["providers"].is_array());
}

#[test]
fn test_action_validation_valid() {
    let plugin = StarterPlugin::new();
    let memory = Memory::default();
    
    let is_valid = plugin.validate_action("HELLO_RUST", &memory, None);
    assert!(is_valid);
}

#[test]
fn test_action_validation_invalid() {
    let plugin = StarterPlugin::new();
    let memory = Memory::default();
    
    let is_valid = plugin.validate_action("UNKNOWN_ACTION", &memory, None);
    assert!(!is_valid);
}

#[test]
fn test_action_invocation() {
    let plugin = StarterPlugin::new();
    let mut memory = Memory::default();
    memory.content.text = Some("World".to_string());
    
    let result = plugin.invoke_action("HELLO_RUST", &memory, None, None);
    
    assert!(result.success);
    assert!(result.text.is_some());
    assert!(result.text.unwrap().contains("Hello from Rust"));
}

#[test]
fn test_action_invocation_unknown() {
    let plugin = StarterPlugin::new();
    let memory = Memory::default();
    
    let result = plugin.invoke_action("UNKNOWN_ACTION", &memory, None, None);
    
    assert!(!result.success);
    assert!(result.error.is_some());
}

#[test]
fn test_provider_get() {
    let plugin = StarterPlugin::new();
    let memory = Memory::default();
    let state = State::default();
    
    let result = plugin.get_provider("RUST_INFO", &memory, &state);
    
    assert!(result.text.is_some());
    assert!(result.values.is_some());
}

#[test]
fn test_provider_unknown() {
    let plugin = StarterPlugin::new();
    let memory = Memory::default();
    let state = State::default();
    
    let result = plugin.get_provider("UNKNOWN_PROVIDER", &memory, &state);
    
    // Should return empty result, not error
    assert!(result.text.is_none() || result.text.as_ref().map(|s| s.is_empty()).unwrap_or(true));
}

#[test]
fn test_evaluator_validation() {
    let plugin = StarterPlugin::new();
    let memory = Memory::default();
    
    // Plugin has no evaluators, so should return false
    let is_valid = plugin.validate_evaluator("ANY_EVALUATOR", &memory, None);
    assert!(!is_valid);
}

#[test]
fn test_memory_serialization() {
    let mut memory = Memory::default();
    memory.id = Some("123e4567-e89b-12d3-a456-426614174000".to_string());
    memory.content.text = Some("Hello World".to_string());
    memory.content.actions = Some(vec!["ACTION_1".to_string()]);
    
    let json = serde_json::to_string(&memory).unwrap();
    let parsed: Memory = serde_json::from_str(&json).unwrap();
    
    assert_eq!(parsed.content.text, Some("Hello World".to_string()));
    assert_eq!(parsed.content.actions.as_ref().unwrap().len(), 1);
}

#[test]
fn test_state_serialization() {
    let mut state = State::default();
    state.text = Some("Current context".to_string());
    state.values.insert("key".to_string(), serde_json::json!("value"));
    
    let json = serde_json::to_string(&state).unwrap();
    let parsed: State = serde_json::from_str(&json).unwrap();
    
    assert_eq!(parsed.text, Some("Current context".to_string()));
    assert_eq!(parsed.values.get("key").unwrap(), &serde_json::json!("value"));
}

#[test]
fn test_action_result_success() {
    let result = ActionResult::success_with_text("Done!");
    
    assert!(result.success);
    assert_eq!(result.text, Some("Done!".to_string()));
    assert!(result.error.is_none());
}

#[test]
fn test_action_result_failure() {
    let result = ActionResult::failure("Something went wrong");
    
    assert!(!result.success);
    assert_eq!(result.error, Some("Something went wrong".to_string()));
}

#[test]
fn test_action_result_serialization() {
    let result = ActionResult {
        success: true,
        text: Some("Result text".to_string()),
        data: Some({
            let mut map = std::collections::HashMap::new();
            map.insert("key".to_string(), serde_json::json!("value"));
            map
        }),
        ..Default::default()
    };
    
    let json = serde_json::to_string(&result).unwrap();
    let parsed: ActionResult = serde_json::from_str(&json).unwrap();
    
    assert!(parsed.success);
    assert_eq!(parsed.data.unwrap().get("key").unwrap(), &serde_json::json!("value"));
}

#[test]
fn test_provider_result_serialization() {
    let result = ProviderResult {
        text: Some("Provider context".to_string()),
        values: Some({
            let mut map = std::collections::HashMap::new();
            map.insert("count".to_string(), serde_json::json!(42));
            map
        }),
        data: None,
    };
    
    let json = serde_json::to_string(&result).unwrap();
    let parsed: ProviderResult = serde_json::from_str(&json).unwrap();
    
    assert_eq!(parsed.text, Some("Provider context".to_string()));
    assert_eq!(parsed.values.unwrap().get("count").unwrap(), &serde_json::json!(42));
}

#[test]
fn test_handler_options_serialization() {
    let options = HandlerOptions {
        extra: {
            let mut map = std::collections::HashMap::new();
            map.insert("timeout".to_string(), serde_json::json!(5000));
            map
        },
    };
    
    let json = serde_json::to_string(&options).unwrap();
    let parsed: HandlerOptions = serde_json::from_str(&json).unwrap();
    
    assert_eq!(parsed.extra.get("timeout").unwrap(), &serde_json::json!(5000));
}

#[test]
fn test_content_serialization() {
    let content = Content {
        text: Some("Hello".to_string()),
        actions: Some(vec!["ACTION_1".to_string(), "ACTION_2".to_string()]),
        source: Some("test".to_string()),
        data: None,
    };
    
    let json = serde_json::to_string(&content).unwrap();
    let parsed: Content = serde_json::from_str(&json).unwrap();
    
    assert_eq!(parsed.text, Some("Hello".to_string()));
    assert_eq!(parsed.actions.unwrap().len(), 2);
}

#[test]
fn test_unicode_handling() {
    let mut content = Content::default();
    content.text = Some("Hello 世界! 🦀 مرحبا שָׁלוֹם".to_string());
    
    let json = serde_json::to_string(&content).unwrap();
    let parsed: Content = serde_json::from_str(&json).unwrap();
    
    let text = parsed.text.unwrap();
    assert!(text.contains("世界"));
    assert!(text.contains("🦀"));
}

#[test]
fn test_null_handling() {
    let json = r#"{"text": null, "actions": null, "source": null, "data": null}"#;
    let content: Content = serde_json::from_str(json).unwrap();
    
    assert!(content.text.is_none());
    assert!(content.actions.is_none());
}

#[test]
fn test_empty_arrays() {
    let content = Content {
        text: None,
        actions: Some(vec![]),
        source: None,
        data: None,
    };
    
    let json = serde_json::to_string(&content).unwrap();
    let parsed: Content = serde_json::from_str(&json).unwrap();
    
    assert_eq!(parsed.actions.unwrap().len(), 0);
}

#[test]
fn test_nested_data() {
    let mut content = Content::default();
    content.data = Some({
        let mut map = std::collections::HashMap::new();
        map.insert(
            "nested".to_string(),
            serde_json::json!({
                "level1": {
                    "level2": {
                        "value": "deep"
                    }
                }
            }),
        );
        map
    });
    
    let json = serde_json::to_string(&content).unwrap();
    let parsed: Content = serde_json::from_str(&json).unwrap();
    
    let data = parsed.data.unwrap();
    let nested = &data["nested"]["level1"]["level2"]["value"];
    assert_eq!(nested, &serde_json::json!("deep"));
}

