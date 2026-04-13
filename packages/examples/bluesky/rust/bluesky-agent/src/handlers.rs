//! Bluesky Event Handlers
//!
//! These handlers process Bluesky events through the elizaOS pipeline.

use anyhow::Result;
use elizaos::{
    runtime::AgentRuntime,
    services::IMessageService,
    types::primitives::string_to_uuid,
    types::{Content, Memory, ChannelType, UUID, HandlerCallback},
};
use elizaos_plugin_bluesky::{
    BlueSkyClient,
    types::{BlueSkyNotification, CreatePostRequest},
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info};

/// Create a unique UUID by combining base ID with agent ID.
pub fn create_unique_uuid(agent_id: &UUID, base_id: &str) -> UUID {
    if base_id == agent_id.to_string() {
        return agent_id.clone();
    }
    let combined = format!("{}:{}", base_id, agent_id);
    string_to_uuid(&combined)
}

/// Handle incoming Bluesky mentions through the elizaOS pipeline.
pub async fn handle_mention_received(
    runtime: &AgentRuntime,
    notification: &BlueSkyNotification,
    client: Arc<Mutex<BlueSkyClient>>,
) -> Result<()> {
    use elizaos_plugin_bluesky::types::NotificationReason;
    
    // Skip non-mentions
    let dominated = matches!(notification.reason, NotificationReason::Mention | NotificationReason::Reply);
    if !dominated {
        debug!(reason = ?notification.reason, "Skipping notification - not a mention or reply");
        return Ok(());
    }

    let is_mention = matches!(notification.reason, NotificationReason::Mention);

    // Extract text from notification record
    let mention_text = notification.record
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("");

    if mention_text.trim().is_empty() {
        debug!("Empty mention text, skipping");
        return Ok(());
    }

    info!(
        handle = %notification.author.handle,
        reason = ?notification.reason,
        text = %&mention_text[..mention_text.len().min(50)],
        "Processing Bluesky mention through elizaOS pipeline"
    );

    // Create unique IDs for this conversation
    let entity_id = create_unique_uuid(&runtime.agent_id, &notification.author.did);
    let room_id = create_unique_uuid(&runtime.agent_id, &notification.uri);

    // Create the incoming message memory
    let mention_type = if is_mention { "platform_mention" } else { "reply" };

    let mut content = Content {
        text: Some(mention_text.to_string()),
        source: Some("bluesky".to_string()),
        channel_type: Some(ChannelType::Group),
        ..Default::default()
    };

    // Add metadata via the extra field
    content.extra.insert("is_mention".to_string(), serde_json::json!(is_mention));
    content.extra.insert("is_reply".to_string(), serde_json::json!(!is_mention));
    content.extra.insert("mention_type".to_string(), serde_json::json!(mention_type));
    content.extra.insert("uri".to_string(), serde_json::json!(notification.uri));
    content.extra.insert("cid".to_string(), serde_json::json!(notification.cid));
    content.extra.insert("author_did".to_string(), serde_json::json!(notification.author.did));
    content.extra.insert("author_handle".to_string(), serde_json::json!(notification.author.handle));
    content.extra.insert("platform".to_string(), serde_json::json!("bluesky"));

    let mut message = Memory::new(entity_id.clone(), room_id.clone(), content);

    // Capture notification info for callback
    let notification_uri = notification.uri.clone();
    let notification_cid = notification.cid.clone();
    let author_handle = notification.author.handle.clone();
    let agent_id = runtime.agent_id.clone();
    let room_id_for_callback = room_id.clone();
    let message_id = message.id.clone();

    // Define callback to post response to Bluesky
    let callback: HandlerCallback = Arc::new(move |response_content: Content| {
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

            info!(
                text_preview = %&response_text[..response_text.len().min(50)],
                reply_to = %author_handle,
                "Posting reply to Bluesky"
            );

            // Post the reply to Bluesky
            let request = CreatePostRequest::new(&response_text)
                .with_reply(notification_uri.clone(), notification_cid.clone());
            
            match client.lock().await.send_post(request).await {
                Ok(post) => {
                    info!(uri = %post.uri, "Successfully posted reply to Bluesky");
                }
                Err(e) => {
                    tracing::error!(error = %e, "Failed to post reply to Bluesky");
                    // Continue to create memory even if posting failed
                }
            }

            // Create memory for the response
            let mut response_content = Content {
                text: Some(response_text),
                source: Some("bluesky".to_string()),
                in_reply_to: message_id,
                ..Default::default()
            };
            response_content.extra.insert("uri".to_string(), serde_json::json!(notification_uri));
            response_content.extra.insert("cid".to_string(), serde_json::json!(notification_cid));
            response_content.extra.insert("platform".to_string(), serde_json::json!("bluesky"));

            let response_memory = Memory::new(agent_id, room_id, response_content);
            Ok(vec![response_memory])
        })
    });

    // Process through the elizaOS pipeline
    let result = runtime.message_service()
        .handle_message(runtime, &mut message, Some(callback), None)
        .await?;

    debug!(
        did_respond = %result.did_respond,
        "elizaOS pipeline completed"
    );

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
