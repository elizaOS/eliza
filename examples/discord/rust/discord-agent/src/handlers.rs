//! Discord Event Handlers
//!
//! Custom handlers for Discord-specific events like messages,
//! reactions, and member events.

use serde_json::Value;
use tracing::{debug, info};

/// Generate a response to a message.
///
/// This is a simple implementation. In production, you would
/// integrate with an LLM through the elizaOS runtime.
pub fn generate_response(content: &str, username: &str, character_name: &str) -> Option<String> {
    let content_lower = content.to_lowercase();

    // Simple keyword responses
    if content_lower.contains("hello") || content_lower.contains("hi") {
        return Some(format!(
            "👋 Hello, {}! I'm {}. How can I help you today?",
            username, character_name
        ));
    }

    if content_lower.contains("help") {
        return Some(
            r#"**How I can help:**
• Ask me questions and I'll do my best to answer
• Mention me (@) in any channel to chat
• I'm here to assist with various tasks!

What would you like to know?"#
                .to_string(),
        );
    }

    if content_lower.contains("ping") {
        return Some("🏓 Pong! I'm alive and responding!".to_string());
    }

    if content_lower.contains("about") || content_lower.contains("who are you") {
        return Some(format!(
            r#"👋 Hi! I'm **{}**, an AI assistant powered by elizaOS.

I'm a helpful and friendly assistant on Discord. I can answer questions, have conversations, and help with various tasks.

Feel free to ask me anything!"#,
            character_name
        ));
    }

    // Default response for mentions
    Some(format!(
        "Hello {}! I received your message. How can I assist you?",
        username
    ))
}

/// Handle reaction events
pub fn handle_reaction_added(payload: &Value) {
    let emoji = payload
        .get("emoji")
        .and_then(|e| e.as_str())
        .unwrap_or("");
    let user_id = payload
        .get("user_id")
        .and_then(|id| id.as_str())
        .unwrap_or("");
    let message_id = payload
        .get("message_id")
        .and_then(|id| id.as_str())
        .unwrap_or("");

    debug!(
        "Reaction {} added by {} on message {}",
        emoji, user_id, message_id
    );
    // Custom reaction handling can be implemented here
}

/// Handle new member events
pub fn handle_member_joined(payload: &Value) {
    let username = payload
        .get("username")
        .and_then(|u| u.as_str())
        .unwrap_or("unknown");
    let guild_id = payload
        .get("guild_id")
        .and_then(|id| id.as_str())
        .unwrap_or("");

    info!("New member {} joined guild {}", username, guild_id);
    // Welcome message logic can be implemented here
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_response_hello() {
        let response = generate_response("hello there!", "testuser", "DiscordEliza");
        assert!(response.is_some());
        assert!(response.unwrap().contains("Hello, testuser"));
    }

    #[test]
    fn test_generate_response_ping() {
        let response = generate_response("ping", "testuser", "DiscordEliza");
        assert!(response.is_some());
        assert!(response.unwrap().contains("Pong"));
    }

    #[test]
    fn test_generate_response_help() {
        let response = generate_response("can you help me?", "testuser", "DiscordEliza");
        assert!(response.is_some());
        assert!(response.unwrap().contains("How I can help"));
    }

    #[test]
    fn test_generate_response_about() {
        let response = generate_response("who are you?", "testuser", "DiscordEliza");
        assert!(response.is_some());
        assert!(response.unwrap().contains("DiscordEliza"));
    }

    #[test]
    fn test_generate_response_default() {
        let response = generate_response("random message", "testuser", "DiscordEliza");
        assert!(response.is_some());
        assert!(response.unwrap().contains("testuser"));
    }
}
