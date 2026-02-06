#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

pub mod actions;
pub mod parser;
pub mod providers;
pub mod registry;
pub mod types;

pub use parser::{extract_command_args, is_command, normalize_command_name, parse_command};
pub use registry::{default_registry, CommandRegistry};
pub use types::{
    CommandCategory, CommandContext, CommandDefinition, CommandResult, ParsedCommand,
};

pub use actions::get_command_actions;
pub use providers::{get_command_providers, CommandRegistryProvider};

pub const PLUGIN_NAME: &str = "commands";
pub const PLUGIN_DESCRIPTION: &str =
    "Chat command system with /help, /status, /stop, /models, /commands";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

// ── Core traits ──────────────────────────────────────────────────────────

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
        registry: Option<&CommandRegistry>,
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
        registry: Option<&CommandRegistry>,
    ) -> ProviderResult;
}

// ── Prelude ──────────────────────────────────────────────────────────────

pub mod prelude {
    pub use crate::actions::get_command_actions;
    pub use crate::parser::{extract_command_args, is_command, normalize_command_name, parse_command};
    pub use crate::providers::{get_command_providers, CommandRegistryProvider};
    pub use crate::registry::{default_registry, CommandRegistry};
    pub use crate::types::{
        CommandCategory, CommandContext, CommandDefinition, CommandResult, ParsedCommand,
    };
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
    pub use crate::{PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};
}
