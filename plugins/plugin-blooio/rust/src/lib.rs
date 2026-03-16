#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

pub mod constants;
pub mod types;
pub mod utils;

mod service;

pub mod actions;
pub mod providers;

pub use constants::{
    CONVERSATION_CACHE_TTL, DEFAULT_API_BASE_URL, DEFAULT_WEBHOOK_PORT, MAX_CONVERSATION_HISTORY,
    SERVICE_NAME, SIGNATURE_TOLERANCE_SECONDS, WEBHOOK_PATH_EVENTS,
};
pub use types::{
    BlooioConfig, BlooioError, BlooioMessage, BlooioResponse, ConversationEntry, MessageTarget,
    WebhookEvent,
};
pub use utils::{
    extract_urls, validate_chat_id, validate_email, validate_group_id, validate_phone,
    verify_webhook_signature,
};

pub use actions::get_blooio_actions;
pub use providers::get_blooio_providers;
pub use service::BlooioService;

pub const PLUGIN_NAME: &str = "blooio";
pub const PLUGIN_DESCRIPTION: &str = "Blooio plugin for iMessage/SMS messaging integration";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// Core trait definitions (mirror plugin-code gold standard)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ActionExample {
    pub user_message: String,
    pub agent_response: String,
}

#[derive(Debug, Clone)]
pub struct ActionResult {
    pub success: bool,
    pub text: String,
    pub data: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderResult {
    pub values: Value,
    pub text: String,
    pub data: Value,
}

#[async_trait]
pub trait Action: Send + Sync {
    fn name(&self) -> &str;
    fn similes(&self) -> Vec<&str>;
    fn description(&self) -> &str;
    async fn validate(&self, message: &Value, state: &Value) -> bool;
    async fn handler(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&mut BlooioService>,
    ) -> ActionResult;
    fn examples(&self) -> Vec<ActionExample>;
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn position(&self) -> i32;
    async fn get(
        &self,
        message: &Value,
        state: &Value,
        service: Option<&BlooioService>,
    ) -> ProviderResult;
}

/// Convenience re-exports.
pub mod prelude {
    pub use crate::actions::get_blooio_actions;
    pub use crate::providers::{get_blooio_providers, ConversationHistoryProvider};
    pub use crate::service::BlooioService;
    pub use crate::types::*;
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
    pub use crate::{PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};
}
