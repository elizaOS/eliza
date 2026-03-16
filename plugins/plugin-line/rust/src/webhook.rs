//! Webhook event handling for the LINE plugin.
//!
//! Provides webhook signature validation, event parsing, and event types
//! matching the TypeScript implementation's webhook handling for:
//! follow, unfollow, join, leave, postback, and message events.

use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// ---------------------------------------------------------------------------
// Webhook event source
// ---------------------------------------------------------------------------

/// Source of a webhook event (user, group, or room).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookSource {
    #[serde(rename = "type")]
    pub source_type: String,
    #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(rename = "roomId", skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Webhook event types
// ---------------------------------------------------------------------------

/// Follow event — user adds the bot as a friend.
#[derive(Debug, Clone)]
pub struct FollowEvent {
    pub timestamp: i64,
    pub source: WebhookSource,
    pub reply_token: Option<String>,
}

/// Unfollow event — user blocks the bot.
#[derive(Debug, Clone)]
pub struct UnfollowEvent {
    pub timestamp: i64,
    pub source: WebhookSource,
}

/// Join event — bot joins a group or room.
#[derive(Debug, Clone)]
pub struct JoinEvent {
    pub timestamp: i64,
    pub source: WebhookSource,
    pub reply_token: Option<String>,
}

/// Leave event — bot is removed from a group or room.
#[derive(Debug, Clone)]
pub struct LeaveEvent {
    pub timestamp: i64,
    pub source: WebhookSource,
}

/// Postback event — user triggers a postback action.
#[derive(Debug, Clone)]
pub struct PostbackEvent {
    pub timestamp: i64,
    pub source: WebhookSource,
    pub data: String,
    pub params: Option<serde_json::Value>,
    pub reply_token: Option<String>,
}

/// Message event — user sends a message.
#[derive(Debug, Clone)]
pub struct MessageEvent {
    pub timestamp: i64,
    pub source: WebhookSource,
    pub message_id: String,
    pub message_type: String,
    pub reply_token: Option<String>,
    pub text: Option<String>,
    pub mention: Option<serde_json::Value>,
}

/// Union of all webhook event types.
#[derive(Debug, Clone)]
pub enum WebhookEvent {
    Follow(FollowEvent),
    Unfollow(UnfollowEvent),
    Join(JoinEvent),
    Leave(LeaveEvent),
    Postback(PostbackEvent),
    Message(MessageEvent),
}

impl WebhookEvent {
    /// Get the event type as a string.
    pub fn event_type(&self) -> &str {
        match self {
            WebhookEvent::Follow(_) => "follow",
            WebhookEvent::Unfollow(_) => "unfollow",
            WebhookEvent::Join(_) => "join",
            WebhookEvent::Leave(_) => "leave",
            WebhookEvent::Postback(_) => "postback",
            WebhookEvent::Message(_) => "message",
        }
    }

    /// Get the timestamp of the event.
    pub fn timestamp(&self) -> i64 {
        match self {
            WebhookEvent::Follow(e) => e.timestamp,
            WebhookEvent::Unfollow(e) => e.timestamp,
            WebhookEvent::Join(e) => e.timestamp,
            WebhookEvent::Leave(e) => e.timestamp,
            WebhookEvent::Postback(e) => e.timestamp,
            WebhookEvent::Message(e) => e.timestamp,
        }
    }

    /// Get the source of the event.
    pub fn source(&self) -> &WebhookSource {
        match self {
            WebhookEvent::Follow(e) => &e.source,
            WebhookEvent::Unfollow(e) => &e.source,
            WebhookEvent::Join(e) => &e.source,
            WebhookEvent::Leave(e) => &e.source,
            WebhookEvent::Postback(e) => &e.source,
            WebhookEvent::Message(e) => &e.source,
        }
    }
}

// ---------------------------------------------------------------------------
// Signature validation
// ---------------------------------------------------------------------------

/// Validate a LINE webhook signature using HMAC-SHA256.
///
/// # Arguments
/// * `body` - Raw request body bytes.
/// * `signature` - The X-Line-Signature header value (base64-encoded).
/// * `channel_secret` - The channel secret from LINE Developer Console.
///
/// # Returns
/// `true` if the signature is valid.
pub fn validate_signature(body: &[u8], signature: &str, channel_secret: &str) -> bool {
    let mut mac = match HmacSha256::new_from_slice(channel_secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(body);
    let result = mac.finalize().into_bytes();
    let expected = general_purpose::STANDARD.encode(result);
    expected == signature
}

/// Compute a LINE webhook signature for the given body and secret.
///
/// Useful for testing or generating signatures.
pub fn compute_signature(body: &[u8], channel_secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(channel_secret.as_bytes())
        .expect("HMAC can take key of any size");
    mac.update(body);
    let result = mac.finalize().into_bytes();
    general_purpose::STANDARD.encode(result)
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

fn parse_source(data: &serde_json::Value) -> WebhookSource {
    WebhookSource {
        source_type: data["type"].as_str().unwrap_or("user").to_string(),
        user_id: data["userId"].as_str().map(String::from),
        group_id: data["groupId"].as_str().map(String::from),
        room_id: data["roomId"].as_str().map(String::from),
    }
}

/// Parse a single webhook event from its JSON representation.
///
/// Returns `None` for unrecognised event types.
pub fn parse_webhook_event(data: &serde_json::Value) -> Option<WebhookEvent> {
    let event_type = data["type"].as_str().unwrap_or("");
    let timestamp = data["timestamp"].as_i64().unwrap_or(0);
    let source = parse_source(&data["source"]);
    let reply_token = data["replyToken"].as_str().map(String::from);

    match event_type {
        "follow" => Some(WebhookEvent::Follow(FollowEvent {
            timestamp,
            source,
            reply_token,
        })),
        "unfollow" => Some(WebhookEvent::Unfollow(UnfollowEvent {
            timestamp,
            source,
        })),
        "join" => Some(WebhookEvent::Join(JoinEvent {
            timestamp,
            source,
            reply_token,
        })),
        "leave" => Some(WebhookEvent::Leave(LeaveEvent { timestamp, source })),
        "postback" => {
            let pb = &data["postback"];
            Some(WebhookEvent::Postback(PostbackEvent {
                timestamp,
                source,
                data: pb["data"].as_str().unwrap_or("").to_string(),
                params: if pb["params"].is_null() {
                    None
                } else {
                    Some(pb["params"].clone())
                },
                reply_token,
            }))
        }
        "message" => {
            let msg = &data["message"];
            Some(WebhookEvent::Message(MessageEvent {
                timestamp,
                source,
                message_id: msg["id"].as_str().unwrap_or("").to_string(),
                message_type: msg["type"].as_str().unwrap_or("").to_string(),
                reply_token,
                text: msg["text"].as_str().map(String::from),
                mention: if msg["mention"].is_null() {
                    None
                } else {
                    Some(msg["mention"].clone())
                },
            }))
        }
        _ => None,
    }
}

/// Parse all events from a webhook request body.
pub fn parse_webhook_body(body: &serde_json::Value) -> Vec<WebhookEvent> {
    let events = match body["events"].as_array() {
        Some(arr) => arr,
        None => return Vec::new(),
    };

    events.iter().filter_map(parse_webhook_event).collect()
}

/// Create a middleware closure for webhook signature validation.
pub fn create_webhook_middleware(
    channel_secret: String,
) -> impl Fn(&[u8], &str) -> bool {
    move |body: &[u8], signature: &str| validate_signature(body, signature, &channel_secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_and_compute_roundtrip() {
        let secret = "test_secret";
        let body = b"{\"events\":[]}";
        let sig = compute_signature(body, secret);
        assert!(validate_signature(body, &sig, secret));
    }

    #[test]
    fn test_invalid_signature() {
        assert!(!validate_signature(b"body", "bad_sig", "secret"));
    }

    #[test]
    fn test_parse_follow_event() {
        let data = serde_json::json!({
            "type": "follow",
            "timestamp": 1000,
            "source": { "type": "user", "userId": "U123" },
            "replyToken": "rt"
        });
        let event = parse_webhook_event(&data).unwrap();
        assert_eq!(event.event_type(), "follow");
    }

    #[test]
    fn test_parse_unknown_returns_none() {
        let data = serde_json::json!({
            "type": "unknown",
            "timestamp": 0,
            "source": { "type": "user" }
        });
        assert!(parse_webhook_event(&data).is_none());
    }
}
