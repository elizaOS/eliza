//! SEND_MESSAGE action implementation.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::error::{PluginError, PluginResult};
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Content, Memory, MemoryType, State};

use super::Action;

/// Action for sending messages.
pub struct SendMessageAction;

#[async_trait]
impl Action for SendMessageAction {
    fn name(&self) -> &'static str {
        "SEND_MESSAGE"
    }

    fn similes(&self) -> &[&'static str] {
        &["MESSAGE", "DM", "DIRECT_MESSAGE", "POST_MESSAGE", "NOTIFY"]
    }

    fn description(&self) -> &'static str {
        "Send a message to a specific room or entity. \
         Use this for targeted communication outside the current context."
    }

    async fn validate(&self, _runtime: &dyn IAgentRuntime, _message: &Memory) -> bool {
        true
    }

    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        _state: Option<&State>,
        responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult> {
        // Get message content from responses
        let message_text = responses
            .and_then(|r| r.first())
            .and_then(|r| Some(r.content.text.clone()))
            .filter(|t| !t.is_empty())
            .ok_or_else(|| PluginError::InvalidInput("No message content to send".to_string()))?;

        // Determine target
        let target_room_id = message
            .content
            .target
            .as_ref()
            .and_then(|t| t.room_id)
            .or(message.room_id)
            .ok_or_else(|| PluginError::InvalidInput("No target room specified".to_string()))?;

        let target_entity_id: Option<Uuid> = message
            .content
            .target
            .as_ref()
            .and_then(|t| t.entity_id);

        // Create the message memory
        let mut metadata = HashMap::new();
        metadata.insert("type".to_string(), serde_json::json!("SEND_MESSAGE"));
        if let Some(entity_id) = target_entity_id {
            metadata.insert("targetEntityId".to_string(), serde_json::json!(entity_id.to_string()));
        }

        runtime
            .create_memory(
                Content {
                    text: message_text.clone(),
                    actions: vec!["SEND_MESSAGE".to_string()],
                    ..Default::default()
                },
                Some(target_room_id),
                Some(runtime.agent_id()),
                MemoryType::Message,
                metadata,
            )
            .await?;

        let preview = if message_text.len() > 50 {
            format!("{}...", &message_text[..50])
        } else {
            message_text.clone()
        };

        Ok(ActionResult::success("Message sent")
            .with_value("success", true)
            .with_value("messageSent", true)
            .with_value("targetRoomId", target_room_id.to_string())
            .with_data("actionName", "SEND_MESSAGE")
            .with_data("targetRoomId", target_room_id.to_string())
            .with_data("messagePreview", preview))
    }
}

