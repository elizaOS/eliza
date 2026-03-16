#![allow(missing_docs)]

use async_trait::async_trait;
use serde_json::Value;

mod schedule;
mod service;
mod storage;
mod types;

pub mod actions;
pub mod providers;

pub use schedule::{
    compute_next_run, format_schedule, parse_natural_language_schedule, parse_schedule,
    validate_cron_expression,
};
pub use service::CronService;
pub use storage::CronStorage;
pub use types::{
    CronConfig, JobDefinition, JobState, JobUpdate, PayloadType, ScheduleType,
    DEFAULT_MAX_JOBS, DEFAULT_TIMEOUT_MS,
};

pub use actions::get_cron_actions;
pub use providers::{get_cron_providers, CronContextProvider};

pub const PLUGIN_NAME: &str = "cron";
pub const PLUGIN_DESCRIPTION: &str = "Scheduled job management with cron expressions, intervals, and one-time runs";
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
        service: Option<&mut CronService>,
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
        service: Option<&CronService>,
    ) -> ProviderResult;
}

pub mod prelude {
    pub use crate::actions::get_cron_actions;
    pub use crate::providers::{get_cron_providers, CronContextProvider};
    pub use crate::schedule::{
        compute_next_run, format_schedule, parse_natural_language_schedule, parse_schedule,
        validate_cron_expression,
    };
    pub use crate::service::CronService;
    pub use crate::storage::CronStorage;
    pub use crate::types::{
        CronConfig, JobDefinition, JobState, JobUpdate, PayloadType, ScheduleType,
    };
    pub use crate::{Action, ActionExample, ActionResult, Provider, ProviderResult};
    pub use crate::{PLUGIN_DESCRIPTION, PLUGIN_NAME, PLUGIN_VERSION};
}
