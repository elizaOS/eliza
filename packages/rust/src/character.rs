//! Character parsing and validation for elizaOS
//!
//! This module provides functions for loading, parsing, and validating character files.

use crate::types::agent::{Character, CharacterSettings};
use anyhow::{Context, Result};
use std::collections::HashMap;

/// Parse a character from a JSON string
pub fn parse_character(json: &str) -> Result<Character> {
    let character: Character =
        serde_json::from_str(json).context("Failed to parse character JSON")?;
    validate_character(&character).context("Character validation failed")?;
    Ok(character)
}

/// Validate a character configuration
pub fn validate_character(character: &Character) -> Result<()> {
    // Validate name
    if character.name.is_empty() {
        anyhow::bail!("Character name is required");
    }

    // Validate plugins if present
    if let Some(plugins) = &character.plugins {
        for plugin in plugins {
            if plugin.is_empty() {
                anyhow::bail!("Empty plugin name in plugins list");
            }
        }
    }

    Ok(())
}

/// Merge character with default values
pub fn merge_character_defaults(mut character: Character) -> Character {
    // Apply defaults
    if character.settings.is_none() {
        character.settings = Some(CharacterSettings::default());
    }

    if character.plugins.is_none() {
        character.plugins = Some(vec![]);
    }

    // Ensure name matches TS/Py defaults (empty string -> "Unnamed Character")
    if character.name.is_empty() {
        character.name = "Unnamed Character".to_string();
    }

    character
}

/// Build character plugins based on environment variables
pub fn build_character_plugins(env: &HashMap<String, String>) -> Vec<String> {
    let mut plugins: Vec<String> = vec!["@elizaos/plugin-sql".to_string()];

    // Text-only plugins (no embedding support)
    if env
        .get("ANTHROPIC_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        plugins.push("@elizaos/plugin-anthropic".to_string());
    }
    if env
        .get("OPENROUTER_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        plugins.push("@elizaos/plugin-openrouter".to_string());
    }

    // Embedding-capable plugins (before platform plugins)
    if env
        .get("OPENAI_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        plugins.push("@elizaos/plugin-openai".to_string());
    }
    if env
        .get("GOOGLE_GENERATIVE_AI_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        plugins.push("@elizaos/plugin-google-genai".to_string());
    }

    // Platform plugins
    if env
        .get("DISCORD_API_TOKEN")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        plugins.push("@elizaos/plugin-discord".to_string());
    }
    if has_x_config(env) {
        plugins.push("@elizaos/plugin-x".to_string());
    }
    if env
        .get("TELEGRAM_BOT_TOKEN")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        plugins.push("@elizaos/plugin-telegram".to_string());
    }

    // Bootstrap plugin is now part of @elizaos/core and loaded automatically
    // No need to explicitly add it to the plugins list

    // Ollama fallback (only if no other LLM providers configured)
    let has_llm_provider = env
        .get("ANTHROPIC_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        || env
            .get("OPENROUTER_API_KEY")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || env
            .get("OPENAI_API_KEY")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        || env
            .get("GOOGLE_GENERATIVE_AI_API_KEY")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

    if !has_llm_provider {
        plugins.push("@elizaos/plugin-ollama".to_string());
    }

    plugins
}

fn has_x_config(env: &HashMap<String, String>) -> bool {
    env.get("X_API_KEY")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        && env
            .get("X_API_SECRET")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        && env
            .get("X_ACCESS_TOKEN")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        && env
            .get("X_ACCESS_TOKEN_SECRET")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::agent::Bio;

    #[test]
    fn test_parse_character_basic() {
        let json = r#"{
            "name": "TestAgent",
            "bio": "A test agent for testing purposes"
        }"#;

        let character = parse_character(json).unwrap();
        assert_eq!(character.name, "TestAgent");
    }

    #[test]
    fn test_parse_character_with_array_bio() {
        let json = r#"{
            "name": "TestAgent",
            "bio": ["Line 1", "Line 2"]
        }"#;

        let character = parse_character(json).unwrap();
        assert_eq!(character.name, "TestAgent");
        match &character.bio {
            Bio::Multiple(v) => assert_eq!(v.len(), 2),
            _ => panic!("Expected multiple bio"),
        }
    }

    #[test]
    fn test_validate_character() {
        let character = Character {
            name: "TestAgent".to_string(),
            bio: Bio::Single("A test agent".to_string()),
            ..Default::default()
        };

        assert!(validate_character(&character).is_ok());
    }

    #[test]
    fn test_validate_character_empty_name() {
        let character = Character {
            name: "".to_string(),
            bio: Bio::Single("A test agent".to_string()),
            ..Default::default()
        };

        assert!(validate_character(&character).is_err());
    }

    #[test]
    fn test_merge_character_defaults() {
        let character = Character {
            name: "TestAgent".to_string(),
            bio: Bio::Single("".to_string()),
            ..Default::default()
        };

        let merged = merge_character_defaults(character);
        assert!(merged.settings.is_some());
        assert!(merged.plugins.is_some());
    }

    #[test]
    fn test_build_character_plugins_empty_env() {
        let env = HashMap::new();
        let plugins = build_character_plugins(&env);

        // Should include sql and ollama fallback; bootstrap is now part of core
        assert!(plugins.contains(&"@elizaos/plugin-sql".to_string()));
        assert!(plugins.contains(&"@elizaos/plugin-ollama".to_string()));
    }

    #[test]
    fn test_build_character_plugins_with_openai() {
        let mut env = HashMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "test-key".to_string());

        let plugins = build_character_plugins(&env);

        assert!(plugins.contains(&"@elizaos/plugin-openai".to_string()));
        assert!(!plugins.contains(&"@elizaos/plugin-ollama".to_string())); // No fallback
    }
}
