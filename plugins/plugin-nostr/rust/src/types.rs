//! Type definitions for the Nostr plugin.

use bech32::{FromBase32, ToBase32, Variant};
use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use thiserror::Error;

/// Maximum message length for Nostr
pub const MAX_NOSTR_MESSAGE_LENGTH: usize = 4000;

/// Nostr service name
pub const NOSTR_SERVICE_NAME: &str = "nostr";

/// Default Nostr relays
pub const DEFAULT_NOSTR_RELAYS: &[&str] = &[
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
];

lazy_static! {
    /// Pattern for validating hex pubkeys (64 hex characters)
    static ref HEX_PUBKEY_PATTERN: Regex =
        Regex::new(r"^[0-9a-fA-F]{64}$").unwrap();
    
    /// Pattern for validating npub format
    static ref NPUB_PATTERN: Regex =
        Regex::new(r"^npub1[a-z0-9]{58}$").unwrap();
}

/// Event types emitted by the Nostr plugin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NostrEventType {
    MessageReceived,
    MessageSent,
    RelayConnected,
    RelayDisconnected,
    ProfilePublished,
    ConnectionReady,
}

impl std::fmt::Display for NostrEventType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NostrEventType::MessageReceived => write!(f, "NOSTR_MESSAGE_RECEIVED"),
            NostrEventType::MessageSent => write!(f, "NOSTR_MESSAGE_SENT"),
            NostrEventType::RelayConnected => write!(f, "NOSTR_RELAY_CONNECTED"),
            NostrEventType::RelayDisconnected => write!(f, "NOSTR_RELAY_DISCONNECTED"),
            NostrEventType::ProfilePublished => write!(f, "NOSTR_PROFILE_PUBLISHED"),
            NostrEventType::ConnectionReady => write!(f, "NOSTR_CONNECTION_READY"),
        }
    }
}

/// Nostr profile data (kind:0)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NostrProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nip05: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lud16: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
}

/// Configuration settings for the Nostr plugin
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrSettings {
    pub private_key: String,
    pub public_key: String,
    pub relays: Vec<String>,
    pub dm_policy: String,
    pub allow_from: Vec<String>,
    pub profile: Option<NostrProfile>,
    pub enabled: bool,
}

impl Default for NostrSettings {
    fn default() -> Self {
        Self {
            private_key: String::new(),
            public_key: String::new(),
            relays: DEFAULT_NOSTR_RELAYS.iter().map(|s| s.to_string()).collect(),
            dm_policy: "pairing".to_string(),
            allow_from: Vec::new(),
            profile: None,
            enabled: true,
        }
    }
}

/// Nostr event (kind:4 for DMs)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrEvent {
    pub id: String,
    pub pubkey: String,
    pub content: String,
    pub created_at: i64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub sig: String,
}

/// Nostr message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrMessage {
    pub from: String,
    pub text: String,
    pub event_id: String,
    pub created_at: i64,
}

/// Options for sending a DM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrDmSendOptions {
    pub to_pubkey: String,
    pub text: String,
}

/// Result from sending a DM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NostrSendResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(default)]
    pub relays: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl NostrSendResult {
    pub fn success(event_id: String, relays: Vec<String>) -> Self {
        Self {
            success: true,
            event_id: Some(event_id),
            relays,
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            event_id: None,
            relays: Vec::new(),
            error: Some(error.into()),
        }
    }
}

/// Error types for the Nostr plugin
#[derive(Error, Debug)]
pub enum NostrPluginError {
    #[error("Configuration error: {message}")]
    Configuration {
        message: String,
        setting: Option<String>,
    },

    #[error("Relay error: {message}")]
    Relay {
        message: String,
        relay: Option<String>,
    },

    #[error("Cryptography error: {message}")]
    Crypto { message: String },

    #[error("Service not initialized")]
    NotInitialized,

    #[error("WebSocket error: {0}")]
    WebSocket(String),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl NostrPluginError {
    pub fn configuration(message: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: None,
        }
    }

    pub fn configuration_with_setting(message: impl Into<String>, setting: impl Into<String>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: Some(setting.into()),
        }
    }

    pub fn relay(message: impl Into<String>) -> Self {
        Self::Relay {
            message: message.into(),
            relay: None,
        }
    }

    pub fn relay_with_url(message: impl Into<String>, relay: impl Into<String>) -> Self {
        Self::Relay {
            message: message.into(),
            relay: Some(relay.into()),
        }
    }

    pub fn crypto(message: impl Into<String>) -> Self {
        Self::Crypto {
            message: message.into(),
        }
    }
}

// Utility functions

/// Check if a string is a valid Nostr pubkey (hex or npub)
pub fn is_valid_pubkey(input: &str) -> bool {
    let trimmed = input.trim();

    // npub format
    if trimmed.starts_with("npub1") {
        return NPUB_PATTERN.is_match(trimmed);
    }

    // Hex format
    HEX_PUBKEY_PATTERN.is_match(trimmed)
}

/// Normalize a pubkey to hex format (accepts npub or hex)
pub fn normalize_pubkey(input: &str) -> Result<String, NostrPluginError> {
    let trimmed = input.trim();

    // npub format - decode to hex
    if trimmed.starts_with("npub1") {
        let (hrp, data, _variant) = bech32::decode(trimmed)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid npub key: {}", e)))?;

        if hrp != "npub" {
            return Err(NostrPluginError::crypto("Invalid npub key: wrong prefix"));
        }

        let converted = Vec::<u8>::from_base32(&data)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid npub key: {}", e)))?;

        return Ok(hex::encode(converted));
    }

    // Already hex - validate and return lowercase
    if !HEX_PUBKEY_PATTERN.is_match(trimmed) {
        return Err(NostrPluginError::crypto(
            "Pubkey must be 64 hex characters or npub format",
        ));
    }

    Ok(trimmed.to_lowercase())
}

/// Convert a hex pubkey to npub format
pub fn pubkey_to_npub(hex_pubkey: &str) -> Result<String, NostrPluginError> {
    let normalized = normalize_pubkey(hex_pubkey)?;
    let data = hex::decode(&normalized)
        .map_err(|e| NostrPluginError::crypto(format!("Invalid hex pubkey: {}", e)))?;

    let encoded = bech32::encode("npub", data.to_base32(), Variant::Bech32)
        .map_err(|e| NostrPluginError::crypto(format!("Failed to encode npub: {}", e)))?;

    Ok(encoded)
}

/// Validate and normalize a private key (accepts hex or nsec format)
pub fn validate_private_key(key: &str) -> Result<[u8; 32], NostrPluginError> {
    let trimmed = key.trim();

    // Handle nsec (bech32) format
    if trimmed.starts_with("nsec1") {
        let (hrp, data, _variant) = bech32::decode(trimmed)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid nsec key: {}", e)))?;

        if hrp != "nsec" {
            return Err(NostrPluginError::crypto("Invalid nsec key: wrong prefix"));
        }

        let converted = Vec::<u8>::from_base32(&data)
            .map_err(|e| NostrPluginError::crypto(format!("Invalid nsec key: {}", e)))?;

        if converted.len() != 32 {
            return Err(NostrPluginError::crypto("Invalid nsec key: wrong length"));
        }

        let mut result = [0u8; 32];
        result.copy_from_slice(&converted);
        return Ok(result);
    }

    // Handle hex format
    if !HEX_PUBKEY_PATTERN.is_match(trimmed) {
        return Err(NostrPluginError::crypto(
            "Private key must be 64 hex characters or nsec bech32 format",
        ));
    }

    let decoded = hex::decode(trimmed)
        .map_err(|e| NostrPluginError::crypto(format!("Invalid hex private key: {}", e)))?;

    if decoded.len() != 32 {
        return Err(NostrPluginError::crypto("Invalid private key length"));
    }

    let mut result = [0u8; 32];
    result.copy_from_slice(&decoded);
    Ok(result)
}

/// Get display name for a pubkey
pub fn get_pubkey_display_name(pubkey: &str) -> String {
    if let Ok(normalized) = normalize_pubkey(pubkey) {
        format!("{}...{}", &normalized[..8], &normalized[56..])
    } else {
        pubkey.to_string()
    }
}

/// Split long text into chunks for Nostr
pub fn split_message_for_nostr(text: &str, max_length: Option<usize>) -> Vec<String> {
    let max_len = max_length.unwrap_or(MAX_NOSTR_MESSAGE_LENGTH);

    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a good break point
        let mut break_point = max_len;

        // Try newline first
        if let Some(idx) = remaining[..max_len].rfind('\n') {
            if idx > max_len / 2 {
                break_point = idx + 1;
            }
        } else if let Some(idx) = remaining[..max_len].rfind(' ') {
            // Try space
            if idx > max_len / 2 {
                break_point = idx + 1;
            }
        }

        chunks.push(remaining[..break_point].trim_end().to_string());
        remaining = remaining[break_point..].trim_start();
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_pubkey_hex() {
        let valid_hex = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
        assert!(is_valid_pubkey(valid_hex));

        let invalid_hex = "7e7e9c42a91bfef19fa929e5fda1b72e";
        assert!(!is_valid_pubkey(invalid_hex));
    }

    #[test]
    fn test_split_message() {
        let short = "Hello";
        assert_eq!(split_message_for_nostr(short, None), vec!["Hello"]);

        let long = "a".repeat(5000);
        let chunks = split_message_for_nostr(&long, Some(1000));
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.len() <= 1000));
    }
}
