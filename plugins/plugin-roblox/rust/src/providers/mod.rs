//! Providers for the Roblox plugin.
//!
//! This module provides context providers that supply information about
//! Roblox game state to elizaOS agents.

use serde::{Deserialize, Serialize};

/// Game state information provided to agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameStateInfo {
    /// Universe ID of the connected experience
    pub universe_id: String,
    /// Optional Place ID
    pub place_id: Option<String>,
    /// Experience name (if available)
    pub experience_name: Option<String>,
    /// Current player count (if available)
    pub active_players: Option<u64>,
    /// Total visits (if available)
    pub total_visits: Option<u64>,
    /// Creator name
    pub creator_name: Option<String>,
    /// Messaging topic
    pub messaging_topic: String,
    /// Whether dry run mode is enabled
    pub dry_run: bool,
}

impl GameStateInfo {
    /// Format as a readable string for agent context.
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
}

