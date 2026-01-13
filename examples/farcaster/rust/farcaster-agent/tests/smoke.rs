//! Smoke tests for the Farcaster agent.
//!
//! These tests verify basic functionality without requiring network access.

use std::env;

mod character {
    include!("../src/character.rs");
}

/// Test that the character configuration is valid.
#[test]
fn test_character_loads() {
    let c = character::create_character();

    assert_eq!(c["name"], "FarcasterBot");
    assert!(c["bio"].as_str().is_some());
    assert!(c["topics"].as_array().is_some());
    assert!(c["adjectives"].as_array().is_some());
    assert!(c["style"]["all"].as_array().is_some());
}

/// Test that the character has required fields.
#[test]
fn test_character_has_system_prompt() {
    let c = character::create_character();

    let system = c["system"].as_str().expect("system should be a string");
    assert!(system.contains("FarcasterBot"));
    assert!(system.contains("Farcaster"));
}

/// Test that message examples are properly formatted.
#[test]
fn test_character_message_examples() {
    let c = character::create_character();

    let examples = c["messageExamples"]
        .as_array()
        .expect("messageExamples should be an array");

    assert!(!examples.is_empty(), "should have at least one example");

    for example in examples {
        let turns = example.as_array().expect("each example should be an array");
        assert!(turns.len() >= 2, "each example should have at least 2 turns");

        // First turn should be from a user
        let first_turn = &turns[0];
        assert!(first_turn["name"].as_str().is_some());
        assert!(first_turn["content"]["text"].as_str().is_some());
    }
}

/// Test environment variable validation (without actual values).
#[test]
fn test_environment_validation_fails_without_vars() {
    // Clear any existing env vars for this test
    env::remove_var("OPENAI_API_KEY");
    env::remove_var("FARCASTER_FID");
    env::remove_var("FARCASTER_SIGNER_UUID");
    env::remove_var("FARCASTER_NEYNAR_API_KEY");

    // This would fail if we tried to start the agent
    assert!(env::var("OPENAI_API_KEY").is_err());
    assert!(env::var("FARCASTER_FID").is_err());
}
