#![allow(missing_docs)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[async_trait]
pub trait Action: Send + Sync {
    fn name(&self) -> &'static str;
    fn similes(&self) -> Vec<&'static str>;
    fn description(&self) -> &'static str;
    async fn validate(&self, message_text: &str) -> bool;
    async fn handler(&self, params: Value) -> Result<Value, String>;
    fn examples(&self) -> Vec<ActionExample>;
}

pub struct ActionExample {
    pub input: String,
    pub output: String,
}

pub struct SendGameMessageAction;

#[async_trait]
impl Action for SendGameMessageAction {
    fn name(&self) -> &'static str {
        "SEND_ROBLOX_MESSAGE"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "ROBLOX_MESSAGE",
            "GAME_MESSAGE",
            "SEND_TO_GAME",
            "BROADCAST_MESSAGE",
            "TELL_PLAYERS",
        ]
    }

    fn description(&self) -> &'static str {
        "Send a message to players in a Roblox game. Can target all players or specific player IDs."
    }

    async fn validate(&self, message_text: &str) -> bool {
        let lower = message_text.to_lowercase();
        (lower.contains("send")
            || lower.contains("tell")
            || lower.contains("message")
            || lower.contains("broadcast"))
            && (lower.contains("game") || lower.contains("player") || lower.contains("roblox"))
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'content' parameter".to_string())?;

        let target_player_ids = params
            .get("target_player_ids")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_u64()).collect::<Vec<_>>());

        Ok(serde_json::json!({
            "action": "SEND_ROBLOX_MESSAGE",
            "content": content,
            "target_player_ids": target_player_ids,
            "status": "pending"
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "Tell everyone in the game that there's a special event happening"
                    .to_string(),
                output: "I'll announce the special event to all players in the game!".to_string(),
            },
            ActionExample {
                input: "Send a message to player123 welcoming them to the game".to_string(),
                output: "I'll send a personalized welcome message to player123.".to_string(),
            },
        ]
    }
}

pub struct ExecuteGameActionAction;

/// Known in-game action names supported by the TypeScript implementation.
pub const AVAILABLE_GAME_ACTION_NAMES: &[&str] =
    &["give_coins", "teleport", "spawn_entity", "start_event"];

#[async_trait]
impl Action for ExecuteGameActionAction {
    fn name(&self) -> &'static str {
        "EXECUTE_ROBLOX_ACTION"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "ROBLOX_ACTION",
            "GAME_ACTION",
            "DO_IN_GAME",
            "TRIGGER_EVENT",
            "RUN_GAME_COMMAND",
        ]
    }

    fn description(&self) -> &'static str {
        "Execute a custom action in a Roblox game, such as spawning entities, giving rewards, or triggering events."
    }

    async fn validate(&self, message_text: &str) -> bool {
        let lower = message_text.to_lowercase();
        (lower.contains("execute")
            || lower.contains("trigger")
            || lower.contains("spawn")
            || lower.contains("give")
            || lower.contains("teleport")
            || lower.contains("start"))
            && (lower.contains("game") || lower.contains("roblox") || lower.contains("player"))
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let action_name = params
            .get("action_name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing 'action_name' parameter".to_string())?;

        let parameters = params
            .get("parameters")
            .cloned()
            .unwrap_or(Value::Object(serde_json::Map::new()));

        Ok(serde_json::json!({
            "action": "EXECUTE_ROBLOX_ACTION",
            "action_name": action_name,
            "parameters": parameters,
            "status": "pending"
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "Start a fireworks show in the game".to_string(),
                output: "I'll trigger the fireworks show for everyone in the game!".to_string(),
            },
            ActionExample {
                input: "Give player456 100 coins as a reward".to_string(),
                output: "I'll give player456 100 coins right away!".to_string(),
            },
        ]
    }
}

pub struct GetPlayerInfoAction;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PlayerIdentifier {
    Id(u64),
    Username(String),
}

#[async_trait]
impl Action for GetPlayerInfoAction {
    fn name(&self) -> &'static str {
        "GET_ROBLOX_PLAYER_INFO"
    }

    fn similes(&self) -> Vec<&'static str> {
        vec![
            "ROBLOX_PLAYER_INFO",
            "LOOKUP_PLAYER",
            "PLAYER_DETAILS",
            "WHO_IS_PLAYER",
        ]
    }

    fn description(&self) -> &'static str {
        "Look up information about a Roblox player by their ID or username."
    }

    async fn validate(&self, message_text: &str) -> bool {
        let lower = message_text.to_lowercase();
        (lower.contains("who")
            || lower.contains("lookup")
            || lower.contains("info")
            || lower.contains("find"))
            && lower.contains("player")
    }

    async fn handler(&self, params: Value) -> Result<Value, String> {
        let identifier = params
            .get("identifier")
            .ok_or_else(|| "Missing 'identifier' parameter".to_string())?;

        Ok(serde_json::json!({
            "action": "GET_ROBLOX_PLAYER_INFO",
            "identifier": identifier,
            "status": "pending"
        }))
    }

    fn examples(&self) -> Vec<ActionExample> {
        vec![
            ActionExample {
                input: "Who is player123?".to_string(),
                output: "I'll look up the information for player123.".to_string(),
            },
            ActionExample {
                input: "Find info on Roblox user TestUser".to_string(),
                output: "Let me find the details for TestUser.".to_string(),
            },
        ]
    }
}

pub fn get_roblox_action_names() -> Vec<&'static str> {
    vec![
        "SEND_ROBLOX_MESSAGE",
        "EXECUTE_ROBLOX_ACTION",
        "GET_ROBLOX_PLAYER_INFO",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_send_message_validate() {
        let action = SendGameMessageAction;
        assert!(action.validate("send a message to game players").await);
        assert!(action.validate("tell everyone in roblox").await);
        assert!(!action.validate("hello world").await);
    }

    #[tokio::test]
    async fn test_execute_action_validate() {
        let action = ExecuteGameActionAction;
        assert!(action.validate("trigger an event in the game").await);
        assert!(action.validate("spawn a monster in roblox").await);
        assert!(!action.validate("hello world").await);
    }

    #[tokio::test]
    async fn test_get_player_info_validate() {
        let action = GetPlayerInfoAction;
        assert!(action.validate("who is player123").await);
        assert!(action.validate("lookup player info").await);
        assert!(!action.validate("hello world").await);
    }
}
