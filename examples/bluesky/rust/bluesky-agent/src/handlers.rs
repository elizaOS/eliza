//! Bluesky Event Handlers
//!
//! These handlers process Bluesky events through the FULL elizaOS pipeline:
//! - State composition with providers (CHARACTER, RECENT_MESSAGES, ACTIONS, etc.)
//! - shouldRespond evaluation
//! - Action planning and execution
//! - Response generation via messageHandlerTemplate
//! - Evaluators
//!
//! This is the canonical way to handle messages in elizaOS - NO bypassing the pipeline.

use anyhow::Result;
use elizaos::{
    runtime::AgentRuntime,
    types::{Content, Memory, ChannelType, UUID},
    string_to_uuid,
    IMessageService,
};
use elizaos_plugin_bluesky::{
    BlueSkyClient, BlueSkyNotification, CreatePostRequest, PostReference,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

/// World ID for all Bluesky rooms
const BLUESKY_WORLD_ID: &str = "bluesky-world";

/// Create a unique UUID by combining base ID with agent ID.
pub fn create_unique_uuid(agent_id: &UUID, base_id: &str) -> UUID {
    if base_id == agent_id.to_string() {
        return agent_id.clone();
    }
    let combined = format!("{}:{}", base_id, agent_id);
    string_to_uuid(&combined)
}

/// Handle incoming Bluesky mentions through the FULL elizaOS pipeline.
///
/// This processes mentions through message_service.handle_message() which runs:
/// - State composition with all registered providers
/// - shouldRespond evaluation
/// - Action planning (if enabled)
/// - Response generation via the full messageHandlerTemplate
/// - Evaluator execution
pub async fn handle_mention_received(
    runtime: &AgentRuntime,
    notification: &BlueSkyNotification,
    client: Arc<Mutex<BlueSkyClient>>,
) -> Result<()> {
    // Skip non-mentions
    let reason = notification.reason.as_str();
    if reason != "mention" && reason != "reply" {
        debug!(reason = %reason, "Skipping notification - not a mention or reply");
        return Ok(());
    }

    // Extract text from notification
    let mention_text = notification.record.as_ref()
        .and_then(|r| r.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    if mention_text.trim().is_empty() {
        debug!("Empty mention text, skipping");
        return Ok(());
    }

    info!(
        handle = %notification.author.handle,
        reason = %reason,
        text = %&mention_text[..mention_text.len().min(50)],
        "Processing Bluesky mention through elizaOS pipeline"
    );

    // Create unique IDs for this conversation
    let entity_id = create_unique_uuid(&runtime.agent_id(), &notification.author.did);
    let room_id = create_unique_uuid(&runtime.agent_id(), &notification.uri);
    let world_id = string_to_uuid(BLUESKY_WORLD_ID);

    // Ensure the connection exists
    runtime.ensure_connection(
        &entity_id,
        &room_id,
        &notification.author.handle,
        notification.author.display_name.as_deref().unwrap_or(&notification.author.handle),
        "bluesky",
        &notification.uri,
        ChannelType::Group,
        Some(&world_id),
    ).await?;

    // Create the incoming message memory
    let is_mention = reason == "mention";
    let mention_type = if is_mention { "platform_mention" } else { "reply" };

    let mut content = Content {
        text: Some(mention_text.to_string()),
        source: Some("bluesky".to_string()),
        channel_type: Some(ChannelType::Group),
        ..Default::default()
    };

    // Add metadata for mention context
    let mut metadata = serde_json::Map::new();
    metadata.insert("is_mention".to_string(), serde_json::json!(is_mention));
    metadata.insert("is_reply".to_string(), serde_json::json!(!is_mention));
    metadata.insert("mention_type".to_string(), serde_json::json!(mention_type));
    metadata.insert("uri".to_string(), serde_json::json!(notification.uri));
    metadata.insert("cid".to_string(), serde_json::json!(notification.cid));
    metadata.insert("author_did".to_string(), serde_json::json!(notification.author.did));
    metadata.insert("author_handle".to_string(), serde_json::json!(notification.author.handle));
    metadata.insert("platform".to_string(), serde_json::json!("bluesky"));
    content.metadata = Some(serde_json::Value::Object(metadata));

    let mut message = Memory::new(entity_id.clone(), room_id.clone(), content);

    // Capture notification info for callback
    let notification_uri = notification.uri.clone();
    let notification_cid = notification.cid.clone();
    let author_handle = notification.author.handle.clone();
    let agent_id = runtime.agent_id().clone();
    let room_id_for_callback = room_id.clone();
    let message_id = message.id.clone();

    // Define callback to post response to Bluesky
    let callback = move |response_content: Content| {
        let client = client.clone();
        let notification_uri = notification_uri.clone();
        let notification_cid = notification_cid.clone();
        let author_handle = author_handle.clone();
        let agent_id = agent_id.clone();
        let room_id = room_id_for_callback.clone();
        let message_id = message_id.clone();

        Box::pin(async move {
            // Check if response is targeted elsewhere
            if let Some(ref target) = response_content.target {
                if target.to_lowercase() != "bluesky" {
                    debug!(target = %target, "Response targeted elsewhere, skipping Bluesky post");
                    return Ok(vec![]);
                }
            }

            let response_text = match &response_content.text {
                Some(text) if !text.trim().is_empty() => {
                    let text = text.trim();
                    if text.len() > 300 {
                        format!("{}...", &text[..297])
                    } else {
                        text.to_string()
                    }
                }
                _ => {
                    debug!("No text in response, skipping Bluesky post");
                    return Ok(vec![]);
                }
            };

            // Post the reply to Bluesky
            let client_guard = client.lock().await;
            let post_result = client_guard.send_post(CreatePostRequest {
                content: Content {
                    text: Some(response_text.clone()),
                    ..Default::default()
                },
                reply_to: Some(PostReference {
                    uri: notification_uri,
                    cid: notification_cid,
                }),
            }).await;

            match post_result {
                Ok(post) => {
                    info!(uri = %post.uri, reply_to = %author_handle, "Posted reply to Bluesky");

                    // Create memory for the response
                    let mut response_memory = Memory::new(
                        agent_id.clone(),
                        room_id,
                        Content {
                            text: Some(response_text),
                            source: Some("bluesky".to_string()),
                            in_reply_to: Some(message_id),
                            ..Default::default()
                        },
                    );

                    let mut metadata = serde_json::Map::new();
                    metadata.insert("uri".to_string(), serde_json::json!(post.uri));
                    metadata.insert("cid".to_string(), serde_json::json!(post.cid));
                    metadata.insert("platform".to_string(), serde_json::json!("bluesky"));
                    response_memory.content.metadata = Some(serde_json::Value::Object(metadata));

                    Ok(vec![response_memory])
                }
                Err(e) => {
                    error!(error = %e, "Failed to post reply to Bluesky");
                    Ok(vec![])
                }
            }
        })
    };

    // Process through the FULL elizaOS pipeline
    let result = runtime.message_service()
        .handle_message(runtime, &mut message, Some(Box::new(callback)), None)
        .await?;

    debug!(
        did_respond = %result.did_respond,
        mode = ?result.mode,
        "elizaOS pipeline completed"
    );

    Ok(())
}

/// Handle should_respond events by routing to handle_mention_received.
pub async fn handle_should_respond(
    runtime: &AgentRuntime,
    notification: &BlueSkyNotification,
    client: Arc<Mutex<BlueSkyClient>>,
) -> Result<()> {
    let reason = notification.reason.as_str();
    if reason == "mention" || reason == "reply" {
        handle_mention_received(runtime, notification, client).await
    } else {
        Ok(())
    }
}

/// Handle automated post creation through the elizaOS pipeline.
pub async fn handle_create_post(
    runtime: &AgentRuntime,
    client: Arc<Mutex<BlueSkyClient>>,
    automated: bool,
) -> Result<()> {
    if !automated {
        return Ok(());
    }

    info!("Generating automated Bluesky post via elizaOS pipeline");

    // Create a room for automated posts
    let room_id = create_unique_uuid(&runtime.agent_id(), "bluesky-automated-posts");
    let world_id = string_to_uuid(BLUESKY_WORLD_ID);

    runtime.ensure_connection(
        &runtime.agent_id(),
        &room_id,
        &runtime.character().name,
        &runtime.character().name,
        "bluesky",
        "automated-posts",
        ChannelType::Self_,
        Some(&world_id),
    ).await?;

    // Create trigger message for post generation
    let mut trigger_content = Content {
        text: Some("Generate a new post for Bluesky".to_string()),
        source: Some("bluesky".to_string()),
        ..Default::default()
    };

    let mut metadata = serde_json::Map::new();
    metadata.insert("is_automated_post_trigger".to_string(), serde_json::json!(true));
    metadata.insert("platform".to_string(), serde_json::json!("bluesky"));
    metadata.insert("max_length".to_string(), serde_json::json!(300));
    trigger_content.metadata = Some(serde_json::Value::Object(metadata));

    let mut trigger_message = Memory::new(
        runtime.agent_id().clone(),
        room_id.clone(),
        trigger_content,
    );

    let agent_id = runtime.agent_id().clone();
    let room_id_for_callback = room_id.clone();

    let callback = move |response_content: Content| {
        let client = client.clone();
        let agent_id = agent_id.clone();
        let room_id = room_id_for_callback.clone();

        Box::pin(async move {
            let post_text = match &response_content.text {
                Some(text) if !text.trim().is_empty() => {
                    let text = text.trim();
                    if text.len() > 300 {
                        format!("{}...", &text[..297])
                    } else {
                        text.to_string()
                    }
                }
                _ => {
                    debug!("No text generated for automated post");
                    return Ok(vec![]);
                }
            };

            let client_guard = client.lock().await;
            let post_result = client_guard.send_post(CreatePostRequest {
                content: Content {
                    text: Some(post_text.clone()),
                    ..Default::default()
                },
                reply_to: None,
            }).await;

            match post_result {
                Ok(post) => {
                    info!(uri = %post.uri, "Created automated post on Bluesky");

                    let mut post_memory = Memory::new(
                        agent_id,
                        room_id,
                        Content {
                            text: Some(post_text),
                            source: Some("bluesky".to_string()),
                            ..Default::default()
                        },
                    );

                    let mut metadata = serde_json::Map::new();
                    metadata.insert("uri".to_string(), serde_json::json!(post.uri));
                    metadata.insert("cid".to_string(), serde_json::json!(post.cid));
                    metadata.insert("platform".to_string(), serde_json::json!("bluesky"));
                    metadata.insert("automated".to_string(), serde_json::json!(true));
                    post_memory.content.metadata = Some(serde_json::Value::Object(metadata));

                    Ok(vec![post_memory])
                }
                Err(e) => {
                    error!(error = %e, "Failed to create automated post");
                    Ok(vec![])
                }
            }
        })
    };

    runtime.message_service()
        .handle_message(runtime, &mut trigger_message, Some(Box::new(callback)), None)
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_unique_uuid_same_id() {
        let agent_id = UUID::new_v4();
        let result = create_unique_uuid(&agent_id, &agent_id.to_string());
        assert_eq!(result, agent_id);
    }

    #[test]
    fn test_create_unique_uuid_different_id() {
        let agent_id = UUID::new_v4();
        let result = create_unique_uuid(&agent_id, "different-id");
        assert_ne!(result, agent_id);
    }
}
