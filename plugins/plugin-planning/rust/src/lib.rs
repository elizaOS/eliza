//! Comprehensive planning and execution plugin for ElizaOS.
//!
//! Provides intelligent action planning, message classification,
//! and multi-step execution capabilities.

#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod service;
pub mod types;

pub mod actions;
pub mod providers;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export action/provider traits
pub use actions::{Action, ActionExample};
pub use providers::{Provider, ProviderParams, ProviderResult};

// Re-export actions
pub use actions::{
    AnalyzeInputAction, ProcessAnalysisAction, ExecuteFinalAction, CreatePlanAction,
    get_planning_action_names,
};

// Re-export providers
pub use providers::{MessageClassifierProvider, get_planning_provider_names};

// Re-export main types for convenience
pub use config::PlanningConfig;
pub use error::{PlanningError, Result};
pub use service::PlanningService;
pub use types::{
    ActionPlan, ActionResult, ActionStep, ExecutionModel, MessageClassification,
    PlanExecutionResult, PlanState, PlanningContext, PlanningConstraint, PlanningPreferences,
    RetryPolicy,
};

/// The plugin name identifier.
pub const PLUGIN_NAME: &str = "planning";
/// Human-readable description of the plugin's functionality.
pub const PLUGIN_DESCRIPTION: &str =
    "Comprehensive planning and execution plugin with integrated planning service";
/// Current version of the plugin from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");


