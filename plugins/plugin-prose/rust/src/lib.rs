//! elizaos-plugin-prose: OpenProse VM integration for elizaOS
//!
//! OpenProse is a programming language for AI sessions that allows
//! orchestrating multi-agent workflows.

#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

mod error;
mod types;

pub mod actions;
pub mod generated;
pub mod providers;
pub mod services;

pub use error::{ProseError, Result};
pub use services::{get_skill_content, set_skill_content, ProseService};
pub use types::{
    ProseCompileOptions, ProseCompileResult, ProseConfig, ProseConfigBuilder, ProseRunOptions,
    ProseRunResult, ProseSkillFile, ProseStateMode,
};

pub use actions::{get_prose_actions, ProseCompileAction, ProseHelpAction, ProseRunAction};
pub use providers::{get_prose_providers, ProseProvider};

pub const PLUGIN_NAME: &str = "prose";
pub const PLUGIN_DESCRIPTION: &str =
    "OpenProse VM integration - a programming language for AI sessions";
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
        service: Option<&mut ProseService>,
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
        service: Option<&ProseService>,
    ) -> ProviderResult;
}

pub mod prelude {
    pub use crate::actions::{ProseCompileAction, ProseHelpAction, ProseRunAction};
    pub use crate::error::{ProseError, Result};
    pub use crate::providers::ProseProvider;
    pub use crate::services::ProseService;
    pub use crate::types::{
        ProseCompileResult, ProseConfig, ProseRunResult, ProseSkillFile, ProseStateMode,
    };
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
}
