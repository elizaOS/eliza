//! elizaos-plugin-lobster: Lobster workflow runtime integration for elizaOS
//!
//! Lobster is a local-first workflow execution tool for running multi-step
//! pipelines with approval checkpoints.

#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

mod error;
mod service;
mod types;

pub mod actions;
pub mod generated;
pub mod providers;

pub use error::{LobsterError, Result};
pub use service::LobsterService;
pub use types::{
    LobsterAction, LobsterApprovalRequest, LobsterConfig, LobsterConfigBuilder, LobsterEnvelope,
    LobsterErrorEnvelope, LobsterResumeParams, LobsterResult, LobsterRunParams,
    LobsterSuccessEnvelope,
};

pub use actions::{get_lobster_actions, LobsterResumeAction, LobsterRunAction};
pub use providers::{get_lobster_providers, LobsterProvider};

pub const PLUGIN_NAME: &str = "lobster";
pub const PLUGIN_DESCRIPTION: &str =
    "Lobster workflow runtime for multi-step pipelines with approval checkpoints";
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
        service: Option<&mut LobsterService>,
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
        service: Option<&LobsterService>,
    ) -> ProviderResult;
}

pub mod prelude {
    pub use crate::actions::{LobsterResumeAction, LobsterRunAction};
    pub use crate::error::{LobsterError, Result};
    pub use crate::providers::LobsterProvider;
    pub use crate::service::LobsterService;
    pub use crate::types::{
        LobsterApprovalRequest, LobsterConfig, LobsterEnvelope, LobsterResult,
    };
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
}
