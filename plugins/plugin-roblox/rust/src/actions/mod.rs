#![allow(missing_docs)]
//! Actions for the Roblox plugin.
//!
//! This module provides action definitions that can be used by elizaOS agents
//! to interact with Roblox games.

use serde::{Deserialize, Serialize};

/// Action to send a message to Roblox game players.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendGameMessageAction {
    /// Message content to send
    pub content: String,
    /// Optional list of target player IDs (None = broadcast to all)
    pub target_player_ids: Option<Vec<u64>>,
}

/// Action to execute a custom game action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteGameAction {
    /// Action name
    pub action_name: String,
    /// Action parameters
    pub parameters: serde_json::Value,
    /// Optional list of target player IDs
    pub target_player_ids: Option<Vec<u64>>,
}

/// Action to look up a player by ID or username.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetPlayerInfoAction {
    /// Player identifier (ID or username)
    pub identifier: PlayerIdentifier,
}

/// Player identifier type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PlayerIdentifier {
    /// Numeric user ID
    Id(u64),
    /// Username string
    Username(String),
}

/// Result of a player lookup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerInfoResult {
    /// User ID
    pub id: u64,
    /// Username
    pub username: String,
    /// Display name
    pub display_name: String,
    /// Avatar URL
    pub avatar_url: Option<String>,
    /// Whether the account is banned
    pub is_banned: bool,
}







