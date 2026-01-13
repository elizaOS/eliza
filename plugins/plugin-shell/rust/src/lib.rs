#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

mod error;
mod path_utils;
mod service;
mod types;

pub mod actions;
pub mod providers;

pub use error::{Result, ShellError};
pub use path_utils::{
    extract_base_command, is_forbidden_command, is_safe_command, validate_path,
    DEFAULT_FORBIDDEN_COMMANDS,
};
pub use service::ShellService;
pub use types::{
    CommandHistoryEntry, CommandResult, FileOperation, FileOperationType, ShellConfig,
    ShellConfigBuilder,
};

pub use actions::{get_shell_actions, ClearHistoryAction, ExecuteCommandAction};
pub use providers::{get_shell_providers, ShellHistoryProvider};

pub const PLUGIN_NAME: &str = "shell";
pub const PLUGIN_DESCRIPTION: &str =
    "Execute shell commands within a restricted directory with history tracking";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

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
        service: Option<&mut ShellService>,
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
        service: Option<&ShellService>,
    ) -> ProviderResult;
}

pub mod prelude {
    pub use crate::actions::{ClearHistoryAction, ExecuteCommandAction};
    pub use crate::error::{Result, ShellError};
    pub use crate::providers::ShellHistoryProvider;
    pub use crate::service::ShellService;
    pub use crate::types::{CommandHistoryEntry, CommandResult, FileOperation, ShellConfig};
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
}
