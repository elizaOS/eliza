//! Type definitions for the webhooks plugin.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Criteria for matching an incoming webhook to a mapping.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HookMatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Declares how an incoming webhook payload is transformed into a wake or
/// agent action.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookMapping {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#match: Option<HookMatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<HookAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_mode: Option<WakeMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deliver: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_unsafe_external_content: Option<bool>,
}

/// The type of action a hook mapping resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookAction {
    Wake,
    Agent,
}

/// When to trigger a heartbeat wake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WakeMode {
    #[serde(rename = "now")]
    Now,
    #[serde(rename = "next-heartbeat")]
    NextHeartbeat,
}

impl Default for WakeMode {
    fn default() -> Self {
        Self::Now
    }
}

/// Resolved hooks configuration from character settings.
#[derive(Debug, Clone)]
pub struct HooksConfig {
    pub token: String,
    pub mappings: Vec<HookMapping>,
    pub presets: Vec<String>,
}

/// Result of applying a [`HookMapping`] to a payload.
#[derive(Debug, Clone)]
pub struct AppliedMapping {
    pub action: HookAction,
    pub wake_mode: WakeMode,
    pub text: Option<String>,
    pub message: Option<String>,
    pub name: Option<String>,
    pub session_key: Option<String>,
    pub deliver: Option<bool>,
    pub channel: Option<String>,
    pub to: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub timeout_seconds: Option<u64>,
}

/// JSON-like value type used for route handler responses.
pub type JsonMap = HashMap<String, serde_json::Value>;

/// Structured response returned by every handler.
#[derive(Debug, Clone)]
pub struct HandlerResponse {
    pub status_code: u16,
    pub body: serde_json::Value,
}

impl HandlerResponse {
    pub fn new(status_code: u16, body: serde_json::Value) -> Self {
        Self { status_code, body }
    }

    pub fn ok(body: serde_json::Value) -> Self {
        Self::new(200, body)
    }
}
