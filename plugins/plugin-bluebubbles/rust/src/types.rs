//! Type definitions for the BlueBubbles plugin.

use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Maximum message length for BlueBubbles.
pub const MAX_BLUEBUBBLES_MESSAGE_LENGTH: usize = 4000;

/// Default timeout in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// Service name for the BlueBubbles plugin.
pub const BLUEBUBBLES_SERVICE_NAME: &str = "bluebubbles";

/// Event types emitted by the BlueBubbles plugin.
pub mod event_types {
    pub const MESSAGE_RECEIVED: &str = "BLUEBUBBLES_MESSAGE_RECEIVED";
    pub const MESSAGE_SENT: &str = "BLUEBUBBLES_MESSAGE_SENT";
    pub const REACTION_RECEIVED: &str = "BLUEBUBBLES_REACTION_RECEIVED";
    pub const TYPING_INDICATOR: &str = "BLUEBUBBLES_TYPING_INDICATOR";
    pub const READ_RECEIPT: &str = "BLUEBUBBLES_READ_RECEIPT";
    pub const CONNECTION_READY: &str = "BLUEBUBBLES_CONNECTION_READY";
    pub const ERROR: &str = "BLUEBUBBLES_ERROR";
}

/// Chat type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlueBubblesChatType {
    Direct,
    Group,
}

impl Default for BlueBubblesChatType {
    fn default() -> Self {
        Self::Direct
    }
}

/// DM policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DmPolicy {
    Open,
    Pairing,
    Allowlist,
    Disabled,
}

impl Default for DmPolicy {
    fn default() -> Self {
        Self::Pairing
    }
}

/// Group policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupPolicy {
    Open,
    Allowlist,
    Disabled,
}

impl Default for GroupPolicy {
    fn default() -> Self {
        Self::Allowlist
    }
}

/// Configuration settings for the BlueBubbles plugin.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueBubblesSettings {
    pub server_url: String,
    pub password: String,
    #[serde(default = "default_webhook_path")]
    pub webhook_path: String,
    #[serde(default)]
    pub dm_policy: DmPolicy,
    #[serde(default)]
    pub group_policy: GroupPolicy,
    #[serde(default)]
    pub allow_from: Vec<String>,
    #[serde(default = "default_true")]
    pub send_read_receipts: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_webhook_path() -> String {
    "/webhooks/bluebubbles".to_string()
}

fn default_true() -> bool {
    true
}

/// BlueBubbles participant.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlueBubblesParticipant {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
}

/// BlueBubbles chat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueBubblesChat {
    pub chat_id: i64,
    pub chat_guid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub chat_type: BlueBubblesChatType,
    #[serde(default)]
    pub participants: Vec<BlueBubblesParticipant>,
}

/// BlueBubbles attachment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlueBubblesAttachment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uti: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
}

/// BlueBubbles message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueBubblesMessage {
    pub guid: String,
    pub text: String,
    pub handle: String,
    pub chat_guid: String,
    pub date_created: i64,
    #[serde(default)]
    pub is_from_me: bool,
    #[serde(default)]
    pub has_attachments: bool,
    #[serde(default)]
    pub attachments: Vec<BlueBubblesAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub associated_message_guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expressive_send_style_id: Option<String>,
}

/// Send options.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlueBubblesSendOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_part_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_id: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_MS
}

/// Send result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueBubblesSendResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BlueBubblesSendResult {
    pub fn success(message_id: Option<String>, chat_id: Option<String>) -> Self {
        Self {
            success: true,
            message_id,
            chat_id,
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            message_id: None,
            chat_id: None,
            error: Some(error.into()),
        }
    }
}

/// Probe result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueBubblesProbeResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac_os_version: Option<String>,
    #[serde(default)]
    pub private_api_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BlueBubblesProbeResult {
    pub fn success(
        server_version: Option<String>,
        mac_os_version: Option<String>,
        private_api_enabled: bool,
    ) -> Self {
        Self {
            ok: true,
            server_version,
            mac_os_version,
            private_api_enabled,
            error: None,
        }
    }

    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            server_version: None,
            mac_os_version: None,
            private_api_enabled: false,
            error: Some(error.into()),
        }
    }
}

/// BlueBubbles send target.
#[derive(Debug, Clone)]
pub enum BlueBubblesSendTarget {
    ChatId(i64),
    ChatGuid(String),
    ChatIdentifier(String),
    Handle {
        address: String,
        service: Option<String>,
    },
}

/// Plugin errors.
#[derive(Debug, Error)]
pub enum BlueBubblesPluginError {
    #[error("Configuration error: {message}")]
    Configuration {
        message: String,
        setting: Option<String>,
    },

    #[error("API error: {message}")]
    Api {
        message: String,
        status_code: Option<u16>,
        body: Option<String>,
    },

    #[error("Connection error: {0}")]
    Connection(String),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Service error: {0}")]
    Service(String),
}

impl BlueBubblesPluginError {
    pub fn configuration(message: impl Into<String>, setting: Option<&str>) -> Self {
        Self::Configuration {
            message: message.into(),
            setting: setting.map(String::from),
        }
    }

    pub fn api(message: impl Into<String>, status_code: Option<u16>, body: Option<String>) -> Self {
        Self::Api {
            message: message.into(),
            status_code,
            body,
        }
    }
}

/// Normalize a BlueBubbles server URL.
pub fn normalize_server_url(url: &str) -> Result<String, BlueBubblesPluginError> {
    let trimmed = url.trim();

    if trimmed.is_empty() {
        return Err(BlueBubblesPluginError::configuration(
            "Server URL is required",
            Some("BLUEBUBBLES_SERVER_URL"),
        ));
    }

    lazy_static! {
        static ref HTTP_RE: Regex = Regex::new(r"^https?://").unwrap();
    }

    let with_scheme = if HTTP_RE.is_match(trimmed) {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };

    Ok(with_scheme.trim_end_matches('/').to_string())
}

/// Build a BlueBubbles API URL.
pub fn build_api_url(
    base_url: &str,
    path: &str,
    password: Option<&str>,
) -> Result<String, BlueBubblesPluginError> {
    let normalized = normalize_server_url(base_url)?;
    let clean_path = path.trim_start_matches('/');
    let full_url = format!("{}/{}", normalized, clean_path);

    Ok(match password {
        Some(pw) if !pw.is_empty() => {
            let separator = if full_url.contains('?') { "&" } else { "?" };
            format!("{}{}password={}", full_url, separator, urlencoding::encode(pw))
        }
        _ => full_url,
    })
}

/// Normalize a handle.
pub fn normalize_handle(handle: &str) -> String {
    lazy_static! {
        static ref PREFIX_RE: Regex = Regex::new(r"(?i)^bluebubbles:").unwrap();
        static ref PHONE_RE: Regex = Regex::new(r"^[\d\s\-\(\)\+]+$").unwrap();
        static ref STRIP_RE: Regex = Regex::new(r"[\s\-\(\)]").unwrap();
    }

    let trimmed = handle.trim();
    let without_prefix = PREFIX_RE.replace(trimmed, "").to_string();

    if PHONE_RE.is_match(&without_prefix) {
        STRIP_RE.replace_all(&without_prefix, "").to_string()
    } else {
        without_prefix
    }
}

/// Extract handle from a chat GUID.
pub fn extract_handle_from_chat_guid(chat_guid: &str) -> Option<String> {
    let parts: Vec<&str> = chat_guid.split(';').collect();

    if parts.len() >= 3 {
        let handle = parts[2].trim();
        if !handle.is_empty() {
            return Some(handle.to_string());
        }
    }

    None
}

/// Parse a BlueBubbles target.
pub fn parse_target(input: &str) -> BlueBubblesSendTarget {
    let trimmed = input.trim();
    let lower = trimmed.to_lowercase();

    if lower.starts_with("chat_guid:") {
        return BlueBubblesSendTarget::ChatGuid(trimmed[10..].to_string());
    }

    if lower.starts_with("chat_id:") {
        if let Ok(id) = trimmed[8..].parse::<i64>() {
            return BlueBubblesSendTarget::ChatId(id);
        }
    }

    if lower.starts_with("chat_identifier:") {
        return BlueBubblesSendTarget::ChatIdentifier(trimmed[16..].to_string());
    }

    lazy_static! {
        static ref PREFIX_RE: Regex = Regex::new(r"(?i)^bluebubbles:").unwrap();
    }

    let without_prefix = PREFIX_RE.replace(trimmed, "").to_string();
    let normalized = normalize_handle(&without_prefix);

    BlueBubblesSendTarget::Handle {
        address: normalized,
        service: None,
    }
}

/// Split text for BlueBubbles messages.
pub fn split_message(text: &str, max_length: usize) -> Vec<String> {
    if text.len() <= max_length {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_length {
            chunks.push(remaining.to_string());
            break;
        }

        let mut break_point = max_length;

        // Try to break at newline
        if let Some(idx) = remaining[..max_length].rfind('\n') {
            if idx > max_length / 2 {
                break_point = idx + 1;
            }
        }

        // If no good newline, try space
        if break_point == max_length {
            if let Some(idx) = remaining[..max_length].rfind(' ') {
                if idx > max_length / 2 {
                    break_point = idx + 1;
                }
            }
        }

        chunks.push(remaining[..break_point].trim_end().to_string());
        remaining = remaining[break_point..].trim_start();
    }

    chunks
}

lazy_static! {
    /// Effect ID mapping.
    pub static ref EFFECT_MAP: HashMap<&'static str, &'static str> = {
        let mut m = HashMap::new();
        m.insert("slam", "com.apple.MobileSMS.expressivesend.impact");
        m.insert("loud", "com.apple.MobileSMS.expressivesend.loud");
        m.insert("gentle", "com.apple.MobileSMS.expressivesend.gentle");
        m.insert("invisible", "com.apple.MobileSMS.expressivesend.invisibleink");
        m.insert("invisible-ink", "com.apple.MobileSMS.expressivesend.invisibleink");
        m.insert("invisibleink", "com.apple.MobileSMS.expressivesend.invisibleink");
        m.insert("echo", "com.apple.messages.effect.CKEchoEffect");
        m.insert("spotlight", "com.apple.messages.effect.CKSpotlightEffect");
        m.insert("balloons", "com.apple.messages.effect.CKHappyBirthdayEffect");
        m.insert("confetti", "com.apple.messages.effect.CKConfettiEffect");
        m.insert("love", "com.apple.messages.effect.CKHeartEffect");
        m.insert("hearts", "com.apple.messages.effect.CKHeartEffect");
        m.insert("lasers", "com.apple.messages.effect.CKLasersEffect");
        m.insert("fireworks", "com.apple.messages.effect.CKFireworksEffect");
        m.insert("celebration", "com.apple.messages.effect.CKSparklesEffect");
        m
    };
}

/// Resolve an effect ID from a short name.
pub fn resolve_effect_id(raw: Option<&str>) -> Option<String> {
    let raw = raw?;

    lazy_static! {
        static ref NORMALIZE_RE: Regex = Regex::new(r"[\s_]+").unwrap();
    }

    let normalized = NORMALIZE_RE.replace_all(raw.trim(), "-").to_lowercase();
    let compact = normalized.replace("-", "");

    EFFECT_MAP
        .get(normalized.as_str())
        .or_else(|| EFFECT_MAP.get(compact.as_str()))
        .map(|s| s.to_string())
        .or_else(|| Some(raw.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_server_url() {
        assert_eq!(
            normalize_server_url("http://192.168.1.100:1234").unwrap(),
            "http://192.168.1.100:1234"
        );
        assert_eq!(
            normalize_server_url("http://192.168.1.100:1234/").unwrap(),
            "http://192.168.1.100:1234"
        );
        assert_eq!(
            normalize_server_url("192.168.1.100:1234").unwrap(),
            "http://192.168.1.100:1234"
        );
        assert!(normalize_server_url("").is_err());
    }

    #[test]
    fn test_normalize_handle() {
        assert_eq!(normalize_handle("+1 (555) 123-4567"), "+15551234567");
        assert_eq!(normalize_handle("test@example.com"), "test@example.com");
        assert_eq!(
            normalize_handle("bluebubbles:+15551234567"),
            "+15551234567"
        );
    }

    #[test]
    fn test_parse_target() {
        match parse_target("chat_guid:iMessage;-;+15551234567") {
            BlueBubblesSendTarget::ChatGuid(guid) => {
                assert_eq!(guid, "iMessage;-;+15551234567");
            }
            _ => panic!("Expected ChatGuid"),
        }

        match parse_target("chat_id:123") {
            BlueBubblesSendTarget::ChatId(id) => assert_eq!(id, 123),
            _ => panic!("Expected ChatId"),
        }

        match parse_target("+15551234567") {
            BlueBubblesSendTarget::Handle { address, .. } => {
                assert_eq!(address, "+15551234567");
            }
            _ => panic!("Expected Handle"),
        }
    }

    #[test]
    fn test_split_message() {
        let short = "Hello";
        assert_eq!(split_message(short, 100), vec!["Hello"]);

        let long = "a".repeat(200);
        let chunks = split_message(&long, 100);
        assert_eq!(chunks.len(), 2);
    }

    #[test]
    fn test_resolve_effect_id() {
        assert_eq!(
            resolve_effect_id(Some("slam")),
            Some("com.apple.MobileSMS.expressivesend.impact".to_string())
        );
        assert_eq!(
            resolve_effect_id(Some("balloons")),
            Some("com.apple.messages.effect.CKHappyBirthdayEffect".to_string())
        );
        assert_eq!(resolve_effect_id(None), None);
    }
}
