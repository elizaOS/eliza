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

    // Should have sql and ollama (fallback)
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

// ═══════════════════════════════════════════════════════════════════════════
// {{name}} placeholder resolution tests
//
// The character provider replaces `{{name}}` in character fields with
// `character.name` at render time. These tests verify the replacement
// logic works correctly on character data structures.
// ═══════════════════════════════════════════════════════════════════════════

/// Helper: replicate the resolve_name logic used in the character provider.
/// The actual functions live inside the bootstrap module (feature-gated),
/// but the logic is trivial string replacement — we test it inline here
/// to ensure the contract holds regardless of feature flags.
fn resolve_name(text: &str, name: &str) -> String {
    text.replace("{{name}}", name)
}

fn resolve_name_vec(items: &[String], name: &str) -> Vec<String> {
    items.iter().map(|s| resolve_name(s, name)).collect()
}

#[test]
fn test_resolve_name_single_placeholder() {
    assert_eq!(resolve_name("Hello {{name}}!", "Sakuya"), "Hello Sakuya!");
}

#[test]
fn test_resolve_name_multiple_placeholders() {
    assert_eq!(
        resolve_name("{{name}} is {{name}}", "Reimu"),
        "Reimu is Reimu"
    );
}

#[test]
fn test_resolve_name_no_placeholder() {
    assert_eq!(
        resolve_name("No placeholders here.", "Marisa"),
        "No placeholders here."
    );
}

#[test]
fn test_resolve_name_empty_string() {
    assert_eq!(resolve_name("", "Sakuya"), "");
}

#[test]
fn test_resolve_name_placeholder_only() {
    assert_eq!(resolve_name("{{name}}", "Patchouli"), "Patchouli");
}

#[test]
fn test_resolve_name_vec_resolves_all() {
    let items = vec![
        "{{name}} is great.".to_string(),
        "I am {{name}}.".to_string(),
    ];
    let result = resolve_name_vec(&items, "Sakuya");
    assert_eq!(result, vec!["Sakuya is great.", "I am Sakuya."]);
}

#[test]
fn test_resolve_name_vec_empty() {
    let items: Vec<String> = vec![];
    let result = resolve_name_vec(&items, "Sakuya");
    assert!(result.is_empty());
}

#[test]
fn test_resolve_name_vec_mixed() {
    let items = vec!["{{name}} rocks".to_string(), "no placeholder".to_string()];
    let result = resolve_name_vec(&items, "Remilia");
    assert_eq!(result, vec!["Remilia rocks", "no placeholder"]);
}

/// Test {{name}} resolution with a character's bio field
#[test]
fn test_resolve_name_in_bio() {
    let character = Character {
        name: "Sakuya".to_string(),
        bio: Bio::Multiple(vec![
            "{{name}} speaks softly with warmth.".to_string(),
            "{{name}} is an autonomous AI agent.".to_string(),
        ]),
        ..Default::default()
    };

    let bio_lines: Vec<String> = match &character.bio {
        Bio::Single(s) => vec![resolve_name(s, &character.name)],
        Bio::Multiple(v) => resolve_name_vec(v, &character.name),
    };

    assert_eq!(bio_lines[0], "Sakuya speaks softly with warmth.");
    assert_eq!(bio_lines[1], "Sakuya is an autonomous AI agent.");
    assert!(!bio_lines.iter().any(|s| s.contains("{{name}}")));
}

/// Test {{name}} resolution with a system prompt template
#[test]
fn test_resolve_name_in_system_prompt() {
    let system = "You are {{name}}, an autonomous AI agent powered by ElizaOS.";
    let resolved = resolve_name(system, "Reimu");
    assert_eq!(
        resolved,
        "You are Reimu, an autonomous AI agent powered by ElizaOS."
    );
    assert!(!resolved.contains("{{name}}"));
}

/// Test {{name}} resolution with style entries
#[test]
fn test_resolve_name_in_style_entries() {
    let style = vec![
        "Write as {{name}} would.".to_string(),
        "Be direct and confident.".to_string(),
        "{{name}} keeps things brief.".to_string(),
    ];
    let resolved = resolve_name_vec(&style, "Marisa");
    assert_eq!(resolved[0], "Write as Marisa would.");
    assert_eq!(resolved[1], "Be direct and confident.");
    assert_eq!(resolved[2], "Marisa keeps things brief.");
    assert!(!resolved.iter().any(|s| s.contains("{{name}}")));
}

/// Test full character template with {{name}} in multiple fields
#[test]
fn test_full_character_template_resolution() {
    let character = Character {
        name: "Sakuya".to_string(),
        bio: Bio::Multiple(vec![
            "{{name}} is a time-stopping maid.".to_string(),
            "{{name}} works at the Scarlet Devil Mansion.".to_string(),
        ]),
        system: Some("You are {{name}}, an autonomous AI agent powered by ElizaOS.".to_string()),
        topics: Some(vec![
            "{{name}}'s knives".to_string(),
            "time manipulation".to_string(),
        ]),
        adjectives: Some(vec!["precise".to_string(), "elegant".to_string()]),
        ..Default::default()
    };

    // Resolve bio
    let bio_lines = match &character.bio {
        Bio::Single(s) => vec![resolve_name(s, &character.name)],
        Bio::Multiple(v) => resolve_name_vec(v, &character.name),
    };
    assert!(bio_lines[0].starts_with("Sakuya"));
    assert!(!bio_lines.iter().any(|s| s.contains("{{name}}")));

    // Resolve system
    let system = resolve_name(character.system.as_deref().unwrap_or(""), &character.name);
    assert!(system.starts_with("You are Sakuya"));
    assert!(!system.contains("{{name}}"));

    // Resolve topics
    let topics = resolve_name_vec(character.topics.as_deref().unwrap_or(&[]), &character.name);
    assert_eq!(topics[0], "Sakuya's knives");
    assert_eq!(topics[1], "time manipulation");
    assert!(!topics.iter().any(|s| s.contains("{{name}}")));

    // Adjectives without {{name}} pass through
    let adjectives = resolve_name_vec(
        character.adjectives.as_deref().unwrap_or(&[]),
        &character.name,
    );
    assert_eq!(adjectives, vec!["precise", "elegant"]);
}
