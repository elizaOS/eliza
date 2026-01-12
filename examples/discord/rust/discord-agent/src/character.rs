//! Discord Agent Character Definition
//!
//! This character configuration defines the bot's personality,
//! system prompt, and Discord-specific settings.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Character definition for the agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Character {
    /// Character name
    pub name: String,
    /// Character biography/description
    pub bio: String,
    /// System prompt for the LLM
    pub system: String,
    /// Optional settings
    pub settings: Option<Value>,
}

impl Default for Character {
    fn default() -> Self {
        create_character()
    }
}

/// Create the Discord agent character
pub fn create_character() -> Character {
    Character {
        name: "DiscordEliza".to_string(),
        bio: "A helpful and friendly AI assistant on Discord. I can answer questions, have conversations, moderate channels, and help with various tasks.".to_string(),
        system: r#"You are DiscordEliza, a helpful AI assistant on Discord.
You are friendly, knowledgeable, and respond appropriately to the context.
Keep responses concise and easy to read in Discord's chat format.
When users mention you or reply to your messages, engage thoughtfully.
Use Discord markdown formatting when it improves readability:
- **bold** for emphasis
- `code` for code snippets
- ```language for code blocks
You can use emojis sparingly to make conversations more engaging.
If asked to perform moderation tasks, explain what actions would be appropriate."#.to_string(),
        settings: Some(json!({
            "discord": {
                "shouldIgnoreBotMessages": true,
                "shouldRespondOnlyToMentions": true
            }
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_character_has_name() {
        let character = create_character();
        assert_eq!(character.name, "DiscordEliza");
    }

    #[test]
    fn test_character_has_bio() {
        let character = create_character();
        assert!(!character.bio.is_empty());
    }

    #[test]
    fn test_character_has_system_prompt() {
        let character = create_character();
        assert!(!character.system.is_empty());
    }

    #[test]
    fn test_character_has_discord_settings() {
        let character = create_character();
        let settings = character.settings.expect("Should have settings");
        let discord = settings.get("discord").expect("Should have discord settings");
        assert_eq!(discord["shouldIgnoreBotMessages"], true);
        assert_eq!(discord["shouldRespondOnlyToMentions"], true);
    }
}
