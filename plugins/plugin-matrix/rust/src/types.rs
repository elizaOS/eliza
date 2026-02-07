//! Type definitions for the Matrix plugin.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Maximum message length for Matrix
pub const MAX_MATRIX_MESSAGE_LENGTH: usize = 4000;

/// Matrix service name
pub const MATRIX_SERVICE_NAME: &str = "matrix";

/// Event types emitted by the Matrix plugin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MatrixEventType {
    MessageReceived,
    MessageSent,
    RoomJoined,
    RoomLeft,
    InviteReceived,
    ReactionReceived,
    TypingReceived,
    SyncComplete,
    ConnectionReady,
    ConnectionLost,
}

impl MatrixEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MessageReceived => "MATRIX_MESSAGE_RECEIVED",
            Self::MessageSent => "MATRIX_MESSAGE_SENT",
            Self::RoomJoined => "MATRIX_ROOM_JOINED",
            Self::RoomLeft => "MATRIX_ROOM_LEFT",
            Self::InviteReceived => "MATRIX_INVITE_RECEIVED",
            Self::ReactionReceived => "MATRIX_REACTION_RECEIVED",
            Self::TypingReceived => "MATRIX_TYPING_RECEIVED",
            Self::SyncComplete => "MATRIX_SYNC_COMPLETE",
            Self::ConnectionReady => "MATRIX_CONNECTION_READY",
            Self::ConnectionLost => "MATRIX_CONNECTION_LOST",
        }
    }
}

/// Configuration settings for the Matrix plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixSettings {
    pub homeserver: String,
    pub user_id: String,
    pub access_token: String,
    pub device_id: Option<String>,
    pub rooms: Vec<String>,
    pub auto_join: bool,
    pub encryption: bool,
    pub require_mention: bool,
    pub enabled: bool,
}

impl Default for MatrixSettings {
    fn default() -> Self {
        Self {
            homeserver: String::new(),
            user_id: String::new(),
            access_token: String::new(),
            device_id: None,
            rooms: Vec::new(),
            auto_join: false,
            encryption: false,
            require_mention: false,
            enabled: true,
        }
    }
}

/// Information about a Matrix user
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixUserInfo {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Represents a Matrix room
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixRoom {
    pub room_id: String,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub canonical_alias: Option<String>,
    pub is_encrypted: bool,
    pub is_direct: bool,
    pub member_count: usize,
}

/// Represents a Matrix message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixMessage {
    pub event_id: String,
    pub room_id: String,
    pub sender: String,
    pub sender_info: MatrixUserInfo,
    pub content: String,
    pub msg_type: String,
    pub formatted_body: Option<String>,
    pub timestamp: u64,
    pub thread_id: Option<String>,
    pub reply_to: Option<String>,
    pub is_edit: bool,
    pub replaces_event_id: Option<String>,
}

/// Options for sending a message
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MatrixMessageSendOptions {
    pub room_id: Option<String>,
    pub reply_to: Option<String>,
    pub thread_id: Option<String>,
    pub formatted: bool,
    pub media_url: Option<String>,
}

/// Result from sending a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatrixSendResult {
    pub success: bool,
    pub event_id: Option<String>,
    pub room_id: Option<String>,
    pub error: Option<String>,
}

impl MatrixSendResult {
    pub fn ok(event_id: String, room_id: String) -> Self {
        Self {
            success: true,
            event_id: Some(event_id),
            room_id: Some(room_id),
            error: None,
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            success: false,
            event_id: None,
            room_id: None,
            error: Some(error.into()),
        }
    }
}

/// Matrix plugin errors
#[derive(Error, Debug)]
pub enum MatrixError {
    #[error("Matrix service not initialized")]
    NotInitialized,

    #[error("Matrix client not connected")]
    NotConnected,

    #[error("Configuration error: {message}")]
    Configuration {
        message: String,
        setting: Option<String>,
    },

    #[error("API error: {message}")]
    Api {
        message: String,
        errcode: Option<String>,
    },

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl MatrixError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: None,
        }
    }

    pub fn config_with_setting(message: impl Into<String>, setting: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: Some(setting.into()),
        }
    }

    pub fn api(message: impl Into<String>) -> Self {
        Self::Api {
            message: message.into(),
            errcode: None,
        }
    }
}

// Utility functions

lazy_static::lazy_static! {
    static ref USER_ID_REGEX: Regex = Regex::new(r"^@[^:]+:.+$").unwrap();
    static ref ROOM_ID_REGEX: Regex = Regex::new(r"^![^:]+:.+$").unwrap();
    static ref ROOM_ALIAS_REGEX: Regex = Regex::new(r"^#[^:]+:.+$").unwrap();
    static ref MATRIX_ID_LOCALPART: Regex = Regex::new(r"^[@#!]([^:]+):").unwrap();
    static ref MATRIX_ID_SERVERPART: Regex = Regex::new(r":(.+)$").unwrap();
}

/// Check if a string is a valid Matrix user ID
pub fn is_valid_matrix_user_id(user_id: &str) -> bool {
    USER_ID_REGEX.is_match(user_id)
}

/// Check if a string is a valid Matrix room ID
pub fn is_valid_matrix_room_id(room_id: &str) -> bool {
    ROOM_ID_REGEX.is_match(room_id)
}

/// Check if a string is a valid Matrix room alias
pub fn is_valid_matrix_room_alias(alias: &str) -> bool {
    ROOM_ALIAS_REGEX.is_match(alias)
}

/// Extract the localpart from a Matrix ID
pub fn get_matrix_localpart(matrix_id: &str) -> &str {
    MATRIX_ID_LOCALPART
        .captures(matrix_id)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or(matrix_id)
}

/// Extract the server part from a Matrix ID
pub fn get_matrix_serverpart(matrix_id: &str) -> &str {
    MATRIX_ID_SERVERPART
        .captures(matrix_id)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or("")
}

/// Get the best display name for a Matrix user
pub fn get_matrix_user_display_name(user: &MatrixUserInfo) -> String {
    user.display_name
        .clone()
        .unwrap_or_else(|| get_matrix_localpart(&user.user_id).to_string())
}

/// Convert a media URL to an HTTP URL via homeserver
pub fn matrix_mxc_to_http(mxc_url: &str, homeserver: &str) -> Option<String> {
    if !mxc_url.starts_with("mxc://") {
        return None;
    }

    let parts: Vec<&str> = mxc_url[6..].splitn(2, '/').collect();
    if parts.len() < 2 {
        return None;
    }

    let server_name = parts[0];
    let media_id = parts[1];
    let base = homeserver.trim_end_matches('/');
    Some(format!(
        "{}/_matrix/media/v3/download/{}/{}",
        base, server_name, media_id
    ))
}

/// Sync response from the Matrix server
#[derive(Debug, Clone, Deserialize)]
pub struct SyncResponse {
    pub next_batch: String,
    pub rooms: Option<SyncRooms>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncRooms {
    pub join: Option<HashMap<String, JoinedRoom>>,
    pub invite: Option<HashMap<String, InvitedRoom>>,
    pub leave: Option<HashMap<String, LeftRoom>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JoinedRoom {
    pub timeline: Option<Timeline>,
    pub state: Option<State>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InvitedRoom {
    pub invite_state: Option<State>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LeftRoom {
    pub timeline: Option<Timeline>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Timeline {
    pub events: Vec<RoomEvent>,
    pub limited: Option<bool>,
    pub prev_batch: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct State {
    pub events: Vec<StateEvent>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RoomEvent {
    pub event_id: String,
    pub sender: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub content: serde_json::Value,
    pub origin_server_ts: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StateEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub state_key: String,
    pub content: serde_json::Value,
    pub sender: Option<String>,
}

/// Room resolve alias response
#[derive(Debug, Clone, Deserialize)]
pub struct RoomAliasResponse {
    pub room_id: String,
    pub servers: Vec<String>,
}

/// Send message response
#[derive(Debug, Clone, Deserialize)]
pub struct SendMessageResponse {
    pub event_id: String,
}

/// Join room response
#[derive(Debug, Clone, Deserialize)]
pub struct JoinRoomResponse {
    pub room_id: String,
}
