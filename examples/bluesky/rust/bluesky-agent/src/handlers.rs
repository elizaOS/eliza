//! Event handlers for Bluesky interactions.

use anyhow::Result;
use elizaos_plugin_bluesky::{BlueSkyClient, CreatePostRequest};
use elizaos_plugin_bluesky::types::{BlueSkyNotification, NotificationReason};
use tracing::{debug, error, info, warn};

use crate::character::AgentCharacter;

/// Template for generating replies to mentions
const REPLY_TEMPLATE: &str = r#"# Task: Generate a reply to a Bluesky mention

You are {agent_name}, responding to a mention on Bluesky.

## Your Character
{bio}

## The Mention
From: @{author_handle}
Text: {mention_text}

## Guidelines
- Keep your response under 280 characters (leave room for @mention)
- Be helpful, friendly, and on-brand
- Address the user's question or comment directly
- Don't use hashtags unless relevant

Generate a concise, engaging reply:"#;

/// Template for generating automated posts (for LLM integration)
#[allow(dead_code)]
const POST_TEMPLATE: &str = r#"# Task: Generate an original Bluesky post

You are {agent_name}, creating an original post on Bluesky.

## Your Character
{bio}

## Post Examples
{post_examples}

## Guidelines
- Keep it under 300 characters
- Be engaging and on-brand
- Share something interesting, helpful, or thought-provoking
- Don't use excessive hashtags or emojis

Generate an original post:"#;

/// Simple text generation using a placeholder response
/// In production, this would call an LLM API
fn generate_simple_response(_character: &AgentCharacter, mention_text: &str) -> String {
    // For this example, generate a simple acknowledgment
    // In production, replace with actual LLM call (OpenAI, Anthropic, etc.)
    let responses = [
        "Thanks for reaching out! 🙌",
        "Great question! Let me think about that...",
        "Hello! Happy to help! 😊",
        "Appreciate the mention! 💙",
        "Thanks for connecting! How can I help?",
    ];

    // Simple hash-based selection for variety
    let hash = mention_text.bytes().fold(0usize, |acc, b| acc.wrapping_add(b as usize));
    let idx = hash % responses.len();

    responses[idx].to_string()
}

/// Generate an automated post
fn generate_automated_post(character: &AgentCharacter) -> String {
    // For this example, cycle through post examples
    // In production, replace with actual LLM call
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let idx = (now as usize) % character.post_examples.len();
    character.post_examples[idx].clone()
}

/// Process an incoming mention and generate a reply.
pub async fn handle_mention_received(
    client: &BlueSkyClient,
    character: &AgentCharacter,
    notification: &BlueSkyNotification,
) -> Result<()> {
    info!(
        handle = %notification.author.handle,
        reason = ?notification.reason,
        "Processing mention"
    );

    // Skip non-mention/reply notifications
    if notification.reason != NotificationReason::Mention
        && notification.reason != NotificationReason::Reply
    {
        return Ok(());
    }

    // Extract post text from record
    let mention_text = notification
        .record
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if mention_text.trim().is_empty() {
        debug!("Empty mention text, skipping");
        return Ok(());
    }

    // Generate reply
    let reply_text = generate_simple_response(character, mention_text);

    if reply_text.is_empty() {
        warn!("Generated empty reply, skipping");
        return Ok(());
    }

    // Post the reply
    let request = CreatePostRequest::new(&reply_text).with_reply(
        notification.uri.clone(),
        notification.cid.clone(),
    );

    match client.send_post(request).await {
        Ok(post) => {
            info!(
                uri = %post.uri,
                reply_to = %notification.author.handle,
                "Posted reply"
            );
        }
        Err(e) => {
            error!(error = %e, "Failed to post reply");
        }
    }

    Ok(())
}

/// Generate and post automated content.
pub async fn handle_create_post(
    client: &BlueSkyClient,
    character: &AgentCharacter,
) -> Result<()> {
    info!("Generating automated post");

    let post_text = generate_automated_post(character);

    if post_text.is_empty() {
        warn!("Generated empty post, skipping");
        return Ok(());
    }

    // Create the post
    match client.send_post(CreatePostRequest::new(&post_text)).await {
        Ok(post) => {
            info!(uri = %post.uri, "Created automated post");
        }
        Err(e) => {
            error!(error = %e, "Failed to create automated post");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reply_template_placeholders() {
        let filled = REPLY_TEMPLATE
            .replace("{agent_name}", "TestBot")
            .replace("{bio}", "A test bot")
            .replace("{author_handle}", "user.bsky.social")
            .replace("{mention_text}", "Hello!");

        assert!(filled.contains("TestBot"));
        assert!(filled.contains("A test bot"));
        assert!(filled.contains("user.bsky.social"));
        assert!(filled.contains("Hello!"));
    }

    #[test]
    fn test_post_template_placeholders() {
        let filled = POST_TEMPLATE
            .replace("{agent_name}", "TestBot")
            .replace("{bio}", "A test bot")
            .replace("{post_examples}", "- Example 1\n- Example 2");

        assert!(filled.contains("TestBot"));
        assert!(filled.contains("Example 1"));
    }

    #[test]
    fn test_generate_simple_response() {
        let character = AgentCharacter::new();
        let response = generate_simple_response(&character, "hello");

        assert!(!response.is_empty());
        assert!(response.len() < 280); // Fits in a Bluesky reply
    }

    #[test]
    fn test_generate_automated_post() {
        let character = AgentCharacter::new();
        let post = generate_automated_post(&character);

        assert!(!post.is_empty());
        assert!(post.len() <= 300); // Fits in a Bluesky post
    }
}
