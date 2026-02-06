//! Emoji list action for Slack.

use crate::service::SlackService;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Action name
pub const EMOJI_LIST_ACTION: &str = "SLACK_EMOJI_LIST";

/// Action similes
pub const EMOJI_LIST_SIMILES: &[&str] = &[
    "LIST_SLACK_EMOJI",
    "SHOW_EMOJI",
    "GET_CUSTOM_EMOJI",
];

/// Action description
pub const EMOJI_LIST_DESCRIPTION: &str = "List custom emoji available in the Slack workspace";

/// Emoji list result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmojiListResult {
    pub success: bool,
    pub emoji: HashMap<String, String>,
    pub emoji_count: usize,
    pub error: Option<String>,
}

/// Execute the emoji list action
pub async fn execute_emoji_list(service: &SlackService) -> EmojiListResult {
    match service.get_emoji_list().await {
        Ok(emoji) => {
            let emoji_count = emoji.len();
            
            // Limit to first 100 emoji for display
            let emoji: HashMap<String, String> = emoji
                .into_iter()
                .take(100)
                .collect();
            
            EmojiListResult {
                success: true,
                emoji,
                emoji_count,
                error: None,
            }
        }
        Err(e) => EmojiListResult {
            success: false,
            emoji: HashMap::new(),
            emoji_count: 0,
            error: Some(e.to_string()),
        },
    }
}
