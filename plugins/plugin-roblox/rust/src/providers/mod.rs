#![allow(missing_docs)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn position(&self) -> i32;
    async fn get(&self, params: ProviderParams) -> ProviderResult;
}

pub struct ProviderParams {
    pub conversation_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub values: HashMap<String, String>,
    pub text: String,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameStateInfo {
    pub universe_id: String,
    pub place_id: Option<String>,
    pub experience_name: Option<String>,
    pub active_players: Option<u64>,
    pub total_visits: Option<u64>,
    pub creator_name: Option<String>,
    pub messaging_topic: String,
    pub dry_run: bool,
}

impl GameStateInfo {
    pub fn to_context_string(&self) -> String {
        let mut parts = vec![
            "## Roblox Game Connection".to_string(),
            String::new(),
            format!("- **Universe ID**: {}", self.universe_id),
        ];

        if let Some(ref place_id) = self.place_id {
            parts.push(format!("- **Place ID**: {}", place_id));
        }

        if let Some(ref name) = self.experience_name {
            parts.push(format!("- **Experience Name**: {}", name));
        }

        if let Some(players) = self.active_players {
            parts.push(format!("- **Active Players**: {}", players));
        }

        if let Some(visits) = self.total_visits {
            parts.push(format!("- **Total Visits**: {}", visits));
        }

        if let Some(ref creator) = self.creator_name {
            parts.push(format!("- **Creator**: {}", creator));
        }

        parts.push(format!("- **Messaging Topic**: {}", self.messaging_topic));

        if self.dry_run {
            parts.push(String::new());
            parts.push("*Note: Dry run mode is enabled - actions are simulated*".to_string());
        }

        parts.join("\n")
    }
}

pub struct GameStateProvider;

#[async_trait]
impl Provider for GameStateProvider {
    fn name(&self) -> &'static str {
        "roblox-game-state"
    }

    fn description(&self) -> &'static str {
        "Provides information about the connected Roblox game/experience"
    }

    fn position(&self) -> i32 {
        50
    }

    async fn get(&self, _params: ProviderParams) -> ProviderResult {
        let values = HashMap::from([
            ("universeId".to_string(), "N/A".to_string()),
            ("placeId".to_string(), "N/A".to_string()),
            ("experienceName".to_string(), "N/A".to_string()),
        ]);

        let text = "Roblox service not connected. Configure ROBLOX_API_KEY and ROBLOX_UNIVERSE_ID to enable.".to_string();

        let data = serde_json::json!({
            "connected": false,
        });

        ProviderResult { values, text, data }
    }
}

pub fn get_roblox_provider_names() -> Vec<&'static str> {
    vec!["roblox-game-state"]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_game_state_to_context() {
        let state = GameStateInfo {
            universe_id: "12345".to_string(),
            place_id: Some("67890".to_string()),
            experience_name: Some("Test Game".to_string()),
            active_players: Some(100),
            total_visits: Some(1000000),
            creator_name: Some("TestCreator".to_string()),
            messaging_topic: "eliza-agent".to_string(),
            dry_run: false,
        };

        let context = state.to_context_string();
        assert!(context.contains("Universe ID"));
        assert!(context.contains("12345"));
        assert!(context.contains("Test Game"));
    }

    #[test]
    fn test_provider_metadata() {
        let provider = GameStateProvider;
        assert_eq!(provider.name(), "roblox-game-state");
        assert_eq!(provider.position(), 50);
    }

    #[tokio::test]
    async fn test_provider_get() {
        let provider = GameStateProvider;
        let params = ProviderParams {
            conversation_id: "test".to_string(),
            agent_id: "test".to_string(),
        };

        let result = provider.get(params).await;
        assert!(result.text.contains("Roblox"));
    }
}
