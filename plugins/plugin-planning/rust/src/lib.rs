#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod service;
pub mod types;

pub mod actions;
pub mod providers;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use actions::{Action, ActionExample};
pub use providers::{Provider, ProviderParams, ProviderResult};

pub use actions::{
    AnalyzeInputAction, ProcessAnalysisAction, ExecuteFinalAction, CreatePlanAction,
    get_planning_action_names,
};

pub use providers::{MessageClassifierProvider, get_planning_provider_names};

pub use config::PlanningConfig;
pub use error::{PlanningError, Result};
pub use service::PlanningService;
pub use types::{
    ActionPlan, ActionResult, ActionStep, ExecutionModel, MessageClassification,
    PlanExecutionResult, PlanState, PlanningContext, PlanningConstraint, PlanningPreferences,
    RetryPolicy,
};

pub const PLUGIN_NAME: &str = "planning";
pub const PLUGIN_DESCRIPTION: &str = "Planning and execution plugin";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");


