//! Integration tests for the Discord agent

use discord_agent::{create_character, generate_response};
use serde_json::json;

#[test]
fn test_character_creation() {
    let character = create_character();
    assert_eq!(character.name, "DiscordEliza");
    assert!(!character.bio.is_empty());
    assert!(!character.system.is_empty());
}

#[test]
fn test_character_discord_settings() {
    let character = create_character();
    let settings = character.settings.expect("Should have settings");
    let discord = settings.get("discord").expect("Should have discord settings");

    assert_eq!(discord["shouldIgnoreBotMessages"], json!(true));
    assert_eq!(discord["shouldRespondOnlyToMentions"], json!(true));
}

#[test]
fn test_generate_response_hello() {
    let response = generate_response("hello!", "testuser", "DiscordEliza");
    assert!(response.is_some());
    let text = response.unwrap();
    assert!(text.contains("Hello"));
    assert!(text.contains("testuser"));
}

#[test]
fn test_generate_response_ping() {
    let response = generate_response("ping", "testuser", "DiscordEliza");
    assert!(response.is_some());
    assert!(response.unwrap().contains("Pong"));
}

#[test]
fn test_generate_response_help() {
    let response = generate_response("help me please", "testuser", "DiscordEliza");
    assert!(response.is_some());
    assert!(response.unwrap().contains("How I can help"));
}

#[test]
fn test_generate_response_about() {
    let response = generate_response("about", "testuser", "DiscordEliza");
    assert!(response.is_some());
    let text = response.unwrap();
    assert!(text.contains("DiscordEliza"));
    assert!(text.contains("elizaOS"));
}

#[test]
fn test_generate_response_default() {
    let response = generate_response("some random message", "bob", "DiscordEliza");
    assert!(response.is_some());
    assert!(response.unwrap().contains("bob"));
}

// Live tests (only run with `cargo test --features live`)
#[cfg(feature = "live")]
mod live_tests {
    #[tokio::test]
    async fn test_discord_connection() {
        // This would test actual Discord connectivity
        // Requires DISCORD_APPLICATION_ID and DISCORD_API_TOKEN to be set
        unimplemented!("Live tests require Discord credentials");
    }
}
