//! Send reaction action for Telegram plugin.

use serde::{Deserialize, Serialize};

use crate::service::TelegramService;
use crate::types::{reactions, SendReactionParams, SendReactionResult};

/// Action name constant.
pub const SEND_REACTION_ACTION: &str = "SEND_TELEGRAM_REACTION";

/// Parameters for the send reaction action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendReactionActionParams {
    /// Chat ID where the message is.
    pub chat_id: i64,
    /// Message ID to react to.
    pub message_id: i64,
    /// Reaction to send (emoji or name).
    pub reaction: String,
    /// Whether to use big/animated reaction.
    #[serde(default)]
    pub is_big: bool,
}

/// Execute the send reaction action.
pub async fn execute_send_reaction(
    service: &TelegramService,
    params: SendReactionActionParams,
) -> SendReactionResult {
    let normalized_reaction = normalize_reaction(&params.reaction);
    
    service
        .send_reaction(SendReactionParams {
            chat_id: params.chat_id,
            message_id: params.message_id,
            reaction: normalized_reaction,
            is_big: params.is_big,
        })
        .await
}

/// Normalize a reaction string to an emoji.
///
/// If the input is already an emoji, returns it as-is.
/// If it's a name, looks it up in the common reactions map.
pub fn normalize_reaction(reaction: &str) -> String {
    if reaction.is_empty() {
        return reactions::THUMBS_UP.to_string();
    }

    // Check if it's already an emoji (non-ASCII first char)
    if reaction.chars().next().map_or(false, |c| c as u32 > 127) {
        return reaction.to_string();
    }

    // Normalize the name
    let normalized = reaction.to_lowercase().replace([' ', '-'], "_");

    // Look up in the map
    match normalized.as_str() {
        "thumbs_up" | "thumbsup" | "like" | "+1" => reactions::THUMBS_UP,
        "thumbs_down" | "thumbsdown" | "dislike" | "-1" => reactions::THUMBS_DOWN,
        "heart" | "love" => reactions::HEART,
        "fire" | "lit" | "hot" => reactions::FIRE,
        "celebration" | "party" | "tada" => reactions::CELEBRATION,
        "crying" | "sad" => reactions::CRYING,
        "thinking" | "hmm" => reactions::THINKING,
        "exploding_head" | "mindblown" => reactions::EXPLODING_HEAD,
        "screaming" | "scared" => reactions::SCREAMING,
        "angry" => reactions::ANGRY,
        "skull" | "dead" => reactions::SKULL,
        "poop" => reactions::POOP,
        "clown" => reactions::CLOWN,
        "eyes" | "look" => reactions::EYES,
        "hundred" | "100" | "perfect" => reactions::HUNDRED,
        "tears_of_joy" | "lol" | "laugh" => reactions::TEARS_OF_JOY,
        "lightning" | "zap" => reactions::LIGHTNING,
        "trophy" | "win" | "winner" => reactions::TROPHY,
        "broken_heart" | "heartbroken" => reactions::BROKEN_HEART,
        "ghost" | "boo" => reactions::GHOST,
        "unicorn" => reactions::UNICORN,
        _ => reactions::THUMBS_UP,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_reaction_emoji() {
        assert_eq!(normalize_reaction("👍"), "👍");
        assert_eq!(normalize_reaction("❤"), "❤");
    }

    #[test]
    fn test_normalize_reaction_name() {
        assert_eq!(normalize_reaction("thumbs_up"), reactions::THUMBS_UP);
        assert_eq!(normalize_reaction("thumbsup"), reactions::THUMBS_UP);
        assert_eq!(normalize_reaction("like"), reactions::THUMBS_UP);
        assert_eq!(normalize_reaction("heart"), reactions::HEART);
        assert_eq!(normalize_reaction("love"), reactions::HEART);
        assert_eq!(normalize_reaction("fire"), reactions::FIRE);
        assert_eq!(normalize_reaction("FIRE"), reactions::FIRE);
    }

    #[test]
    fn test_normalize_reaction_unknown() {
        assert_eq!(normalize_reaction("unknown"), reactions::THUMBS_UP);
        assert_eq!(normalize_reaction(""), reactions::THUMBS_UP);
    }
}
