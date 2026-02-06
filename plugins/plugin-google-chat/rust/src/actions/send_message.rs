//! Send message action for Google Chat plugin.

use crate::service::GoogleChatService;
use crate::types::{
    normalize_space_target, split_message_for_google_chat, GoogleChatMessageSendOptions,
    MAX_GOOGLE_CHAT_MESSAGE_LENGTH,
};
use serde::{Deserialize, Serialize};

/// Parameters for the send message action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageParams {
    pub text: String,
    pub space: Option<String>,
    pub thread: Option<String>,
}

/// Result from the send message action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendMessageResult {
    pub success: bool,
    pub message_name: Option<String>,
    pub space: Option<String>,
    pub chunks_count: usize,
    pub error: Option<String>,
}

/// Execute the send message action.
pub async fn execute_send_message(
    service: &GoogleChatService,
    params: SendMessageParams,
    context_space: Option<&str>,
) -> SendMessageResult {
    // Determine target space
    let target_space = if let Some(ref space) = params.space {
        if space != "current" {
            normalize_space_target(space)
        } else {
            context_space.map(|s| s.to_string())
        }
    } else {
        context_space.map(|s| s.to_string())
    };

    let space = match target_space {
        Some(s) => s,
        None => {
            return SendMessageResult {
                success: false,
                message_name: None,
                space: None,
                chunks_count: 0,
                error: Some("Could not determine target space".to_string()),
            }
        }
    };

    // Split message if too long
    let chunks = split_message_for_google_chat(&params.text, MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
    let chunks_count = chunks.len();

    // Send message(s)
    let mut last_message_name = None;
    for chunk in chunks {
        let options = GoogleChatMessageSendOptions {
            space: Some(space.clone()),
            text: Some(chunk),
            thread: params.thread.clone(),
            attachments: Vec::new(),
        };

        match service.send_message(options).await {
            Ok(result) => {
                if !result.success {
                    return SendMessageResult {
                        success: false,
                        message_name: None,
                        space: Some(space),
                        chunks_count,
                        error: result.error,
                    };
                }
                last_message_name = result.message_name;
            }
            Err(e) => {
                return SendMessageResult {
                    success: false,
                    message_name: None,
                    space: Some(space),
                    chunks_count,
                    error: Some(e.to_string()),
                };
            }
        }
    }

    SendMessageResult {
        success: true,
        message_name: last_message_name,
        space: Some(space),
        chunks_count,
        error: None,
    }
}
