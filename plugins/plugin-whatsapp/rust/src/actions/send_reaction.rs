//! Send reaction action for WhatsApp plugin.

use crate::client::WhatsAppClientError;
use crate::service::WhatsAppService;
use crate::types::{SendReactionParams, SendReactionResult};
use lazy_static::lazy_static;
use std::collections::HashMap;
use tracing::{error, info};

/// Action name.
pub const SEND_REACTION_ACTION: &str = "WHATSAPP_SEND_REACTION";

lazy_static! {
    /// Map of reaction names to emoji.
    pub static ref REACTION_NAME_MAP: HashMap<&'static str, &'static str> = {
        let mut m = HashMap::new();
        m.insert("like", "👍");
        m.insert("thumbsup", "👍");
        m.insert("thumbs_up", "👍");
        m.insert("dislike", "👎");
        m.insert("thumbsdown", "👎");
        m.insert("thumbs_down", "👎");
        m.insert("heart", "❤️");
        m.insert("love", "❤️");
        m.insert("laugh", "😂");
        m.insert("laughing", "😂");
        m.insert("haha", "😂");
        m.insert("lol", "😂");
        m.insert("wow", "😮");
        m.insert("surprised", "😮");
        m.insert("sad", "😢");
        m.insert("cry", "😢");
        m.insert("crying", "😢");
        m.insert("pray", "🙏");
        m.insert("praying", "🙏");
        m.insert("thanks", "🙏");
        m.insert("clap", "👏");
        m.insert("clapping", "👏");
        m.insert("fire", "🔥");
        m.insert("hot", "🔥");
        m.insert("celebrate", "🎉");
        m.insert("celebration", "🎉");
        m.insert("party", "🎉");
        m
    };
}

/// Normalize a reaction to an emoji.
pub fn normalize_reaction(reaction: &str) -> String {
    // If it's already an emoji (non-ASCII and short), return it
    if reaction.len() <= 16 && !reaction.is_ascii() {
        return reaction.to_string();
    }

    // Look up by name
    let lower_reaction = reaction.to_lowercase();
    REACTION_NAME_MAP
        .get(lower_reaction.trim())
        .map(|s| s.to_string())
        .unwrap_or_else(|| reaction.to_string())
}

/// Validate reaction parameters.
pub fn validate(to: &str, message_id: &str, emoji: &str) -> Result<(), String> {
    if to.is_empty() {
        return Err("Recipient phone number is required".to_string());
    }
    if message_id.is_empty() {
        return Err("Message ID is required".to_string());
    }
    if emoji.is_empty() {
        return Err("Emoji is required".to_string());
    }
    Ok(())
}

/// Execute the send reaction action.
pub async fn execute_send_reaction(
    service: &WhatsAppService,
    to: &str,
    message_id: &str,
    emoji: &str,
) -> Result<SendReactionResult, WhatsAppClientError> {
    validate(to, message_id, emoji).map_err(|e| WhatsAppClientError::Config(e))?;

    let normalized_emoji = normalize_reaction(emoji);

    let params = SendReactionParams {
        to: to.to_string(),
        message_id: message_id.to_string(),
        emoji: normalized_emoji.clone(),
    };

    let result = service.send_reaction(&params).await?;

    if result.success {
        info!("Sent reaction {} to message {}", normalized_emoji, message_id);
    } else {
        error!(
            "Failed to send reaction to message {}: {:?}",
            message_id, result.error
        );
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_reaction() {
        assert_eq!(normalize_reaction("like"), "👍");
        assert_eq!(normalize_reaction("thumbsup"), "👍");
        assert_eq!(normalize_reaction("HEART"), "❤️");
        assert_eq!(normalize_reaction("👍"), "👍");
        assert_eq!(normalize_reaction("unknown"), "unknown");
    }

    #[test]
    fn test_validate() {
        assert!(validate("123", "msg_id", "👍").is_ok());
        assert!(validate("", "msg_id", "👍").is_err());
        assert!(validate("123", "", "👍").is_err());
        assert!(validate("123", "msg_id", "").is_err());
    }
}
