//! elizaOS Plugin Planning - Rust Implementation
//!
//! This crate provides planning and execution capabilities for elizaOS agents,
//! including message classification, plan creation, and multi-model execution.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_planning::{PlanningService, PlanningConfig};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = PlanningConfig::default();
//!     let service = PlanningService::new(config);
//!
//!     // Create a comprehensive plan
//!     let context = PlanningContext {
//!         goal: "Build a website".to_string(),
//!         constraints: vec![],
//!         available_actions: vec!["ANALYZE".to_string()],
//!         preferences: None,
//!     };
//!
//!     let plan = service.create_comprehensive_plan(&context).await?;
//!
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod config;
pub mod error;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export main types
pub use config::PlanningConfig;
pub use error::{PlanningError, Result};
pub use service::PlanningService;
pub use types::{
    ActionPlan, ActionStep, ExecutionModel, ExecutionResult, MessageClassification,
    PlanExecutionResult, PlanState, PlanningContext, RetryPolicy,
};

/// Plugin metadata
pub const PLUGIN_NAME: &str = "planning";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Comprehensive planning and execution plugin with unified planning service";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

