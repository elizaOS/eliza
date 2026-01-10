//! Character loading tests for elizaOS Core
//!
//! These tests verify that character files can be loaded and parsed correctly.

use elizaos::{
    build_character_plugins, merge_character_defaults, parse_character,
    types::{Bio, Character},
    validate_character,
};
use std::collections::HashMap;

/// Test loading a minimal character
#[test]
fn test_load_minimal_character() {
    let json = r#"{
        "name": "Minimal Agent",
        "bio": "A minimal test agent"
    }"#;

    let character = parse_character(json).unwrap();
    assert_eq!(character.name, "Minimal Agent");
}

/// Test loading a full character with all fields
#[test]
fn test_load_full_character() {
    let json = r#"{
        "name": "Full Agent",
        "username": "full_agent",
        "bio": ["Line 1", "Line 2"],
        "system": "You are a comprehensive test agent.",
        "topics": ["testing", "development", "rust"],
        "adjectives": ["thorough", "careful", "precise"],
        "plugins": ["@elizaos/plugin-sql"],
        "settings": {
            "debugMode": true,
            "maxTokens": 1000
        },
        "style": {
            "all": ["Be concise", "Be helpful"],
            "chat": ["Be conversational"]
        },
        "messageExamples": [
            [
                {"name": "User", "content": {"text": "Hello"}},
                {"name": "Agent", "content": {"text": "Hi there!"}}
            ]
        ],
        "postExamples": ["Example post 1", "Example post 2"]
    }"#;

    let character = parse_character(json).unwrap();

    assert_eq!(character.name, "Full Agent");
    assert_eq!(character.username, Some("full_agent".to_string()));
    assert!(character.topics.is_some());
    assert_eq!(character.topics.as_ref().unwrap().len(), 3);
    assert!(character.plugins.is_some());
    assert!(character.settings.is_some());
    assert!(character.style.is_some());
    assert!(character.message_examples.is_some());
    assert!(character.post_examples.is_some());
}

/// Test character validation with valid character
#[test]
fn test_validate_valid_character() {
    let character = Character {
        name: "Valid Agent".to_string(),
        bio: Bio::Single("A valid agent".to_string()),
        ..Default::default()
    };

    assert!(validate_character(&character).is_ok());
}

/// Test character validation with empty name
#[test]
fn test_validate_empty_name() {
    let character = Character {
        name: "".to_string(),
        bio: Bio::Single("A test agent".to_string()),
        ..Default::default()
    };

    let result = validate_character(&character);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("name"));
}

/// Test character validation with empty bio
#[test]
fn test_validate_empty_bio() {
    let character = Character {
        name: "Test Agent".to_string(),
        bio: Bio::Single("".to_string()),
        ..Default::default()
    };

    // TS/Py allow empty bio strings (bio is required, but not required to be non-empty)
    assert!(validate_character(&character).is_ok());
}

/// Test merging character defaults
#[test]
fn test_merge_defaults() {
    let character = Character {
        name: "Test Agent".to_string(),
        bio: Bio::Single("Test bio".to_string()),
        ..Default::default()
    };

    let merged = merge_character_defaults(character);

    // Should have settings and plugins after merge
    assert!(merged.settings.is_some());
    assert!(merged.plugins.is_some());
}

/// Test merging character defaults with empty bio
#[test]
fn test_merge_defaults_empty_bio() {
    let character = Character {
        name: "Test Agent".to_string(),
        bio: Bio::Single("".to_string()),
        ..Default::default()
    };

    let merged = merge_character_defaults(character);

    // Bio should be preserved (TS mergeCharacterDefaults does not backfill empty bio)
    match &merged.bio {
        Bio::Single(s) => assert!(s.is_empty()),
        _ => panic!("Expected single bio"),
    }
}

/// Test building plugins from empty environment
#[test]
fn test_build_plugins_empty_env() {
    let env = HashMap::new();
    let plugins = build_character_plugins(&env);

    // Should have sql and ollama (fallback); bootstrap is now part of core
    assert!(plugins.contains(&"@elizaos/plugin-sql".to_string()));
    assert!(plugins.contains(&"@elizaos/plugin-ollama".to_string()));
}

/// Test building plugins with OpenAI key
#[test]
fn test_build_plugins_with_openai() {
    let mut env = HashMap::new();
    env.insert("OPENAI_API_KEY".to_string(), "test-key".to_string());

    let plugins = build_character_plugins(&env);

    assert!(plugins.contains(&"@elizaos/plugin-openai".to_string()));
    // Should not have ollama fallback
    assert!(!plugins.contains(&"@elizaos/plugin-ollama".to_string()));
}

/// Test building plugins with Discord token
#[test]
fn test_build_plugins_with_discord() {
    let mut env = HashMap::new();
    env.insert("DISCORD_API_TOKEN".to_string(), "test-token".to_string());

    let plugins = build_character_plugins(&env);

    assert!(plugins.contains(&"@elizaos/plugin-discord".to_string()));
}

/// Test building plugins with elizaOS Cloud
#[test]
fn test_build_plugins_with_cloud() {
    let mut env = HashMap::new();
    env.insert("ELIZAOS_CLOUD_API_KEY".to_string(), "test-key".to_string());

    let plugins = build_character_plugins(&env);

    // Cloud settings are not part of the core TypeScript/Python plugin builder.
    // Rust should ignore these keys and follow the standard ordering.
    assert!(plugins.contains(&"@elizaos/plugin-sql".to_string()));
    assert!(!plugins.contains(&"@elizaos/plugin-elizacloud".to_string()));
}

/// Test that bootstrap is not included in plugins (it's now part of core)
#[test]
fn test_bootstrap_in_core_not_plugins() {
    let env = HashMap::new();
    let plugins = build_character_plugins(&env);

    // Bootstrap is now part of core, not a separate plugin
    assert!(!plugins.contains(&"@elizaos/plugin-bootstrap".to_string()));
}

/// Test character bio_string method
#[test]
fn test_character_bio_string() {
    let single = Character {
        name: "Test".to_string(),
        bio: Bio::Single("Single bio".to_string()),
        ..Default::default()
    };
    assert_eq!(single.bio_string(), "Single bio");

    let multiple = Character {
        name: "Test".to_string(),
        bio: Bio::Multiple(vec!["Line 1".to_string(), "Line 2".to_string()]),
        ..Default::default()
    };
    assert_eq!(multiple.bio_string(), "Line 1\nLine 2");
}
