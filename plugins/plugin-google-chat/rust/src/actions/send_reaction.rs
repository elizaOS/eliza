//! Send reaction action for Google Chat plugin.

use crate::service::GoogleChatService;
use serde::{Deserialize, Serialize};

/// Parameters for the send reaction action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionParams {
    pub emoji: String,
    pub message_name: String,
    pub remove: bool,
}

/// Result from the send reaction action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionResult {
    pub success: bool,
    pub reaction_name: Option<String>,
    pub emoji: String,
    pub removed_count: Option<usize>,
    pub error: Option<String>,
}

/// Execute the send reaction action.
pub async fn execute_send_reaction(
    service: &GoogleChatService,
    params: SendReactionParams,
    context_message: Option<&str>,
) -> SendReactionResult {
    // Determine target message
    let target_message = if !params.message_name.is_empty() {
        params.message_name.clone()
    } else {
        match context_message {
            Some(m) => m.to_string(),
            None => {
                return SendReactionResult {
                    success: false,
                    reaction_name: None,
                    emoji: params.emoji,
                    removed_count: None,
                    error: Some("Could not determine target message".to_string()),
                }
            }
        }
    };

    // Handle remove case
    if params.remove {
        let reactions = match service.list_reactions(&target_message, None).await {
            Ok(r) => r,
            Err(e) => {
                return SendReactionResult {
                    success: false,
                    reaction_name: None,
                    emoji: params.emoji,
                    removed_count: None,
                    error: Some(e.to_string()),
                }
            }
        };

        let bot_user = service.get_bot_user();
        let mut removed_count = 0;

        for reaction in reactions {
            // Filter by bot user
            if let Some(ref user) = reaction.user {
                if let Some(bu) = bot_user {
                    if user.name != bu && user.name != "users/app" {
                        continue;
                    }
                }
            }

            // Filter by emoji if specified
            if let Some(ref reaction_emoji) = reaction.emoji {
                if !params.emoji.is_empty() && reaction_emoji != &params.emoji {
                    continue;
                }
            }

            // Delete the reaction
            if let Some(ref name) = reaction.name {
                if service.delete_reaction(name).await.is_ok() {
                    removed_count += 1;
                }
            }
        }

        return SendReactionResult {
            success: true,
            reaction_name: None,
            emoji: params.emoji,
            removed_count: Some(removed_count),
            error: None,
        };
    }

    // Add reaction
    match service.send_reaction(&target_message, &params.emoji).await {
        Ok(reaction) => SendReactionResult {
            success: true,
            reaction_name: reaction.name,
            emoji: params.emoji,
            removed_count: None,
            error: None,
        },
        Err(e) => SendReactionResult {
            success: false,
            reaction_name: None,
            emoji: params.emoji,
            removed_count: None,
            error: Some(e.to_string()),
        },
    }
}
