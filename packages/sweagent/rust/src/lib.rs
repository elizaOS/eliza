//! SWE-agent: Software Engineering Agent
//!
//! This crate provides a Rust implementation of SWE-agent, an AI-powered
//! software engineering agent that can autonomously solve coding tasks.
//!
//! # Features
//!
//! - `native` - Native runtime with full async support (default)
//! - `wasm` - WebAssembly support for browser environments
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_sweagent::run::{RunSingle, RunSingleConfig};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     // Configure and run the agent
//!     let config = RunSingleConfig::default();
//!     let mut runner = RunSingle::from_config(config)?;
//!     runner.run().await?;
//!     Ok(())
//! }
//! ```

pub mod agent;
pub mod environment;
pub mod exceptions;
pub mod monitoring;
pub mod run;
pub mod tools;
pub mod types;
pub mod utils;

// Re-export main types for convenience
pub use agent::{
    AgentConfig, DefaultAgent, DefaultAgentConfig, RetryAgent,
    RetryAgentConfig, AbstractAgentHook,
};
pub use types::AgentRunResult;
pub use environment::{
    Deployment, DeploymentConfig, DockerDeployment, DockerDeploymentConfig,
    LocalDeployment, LocalDeploymentConfig, EnvironmentConfig, SWEEnv, RepoConfig,
};
pub use exceptions::SWEAgentError;
pub use run::{RunBatch, RunBatchConfig, RunSingle, RunSingleConfig};
pub use tools::{Bundle, BundleConfig, ParseFunction, ToolConfig, ToolHandler};
pub use types::{History, HistoryItem, StepOutput, Trajectory, TrajectoryStep};
pub use monitoring::{
    AgentMetrics, Alert, AlertHandler, AlertSeverity, AlertThresholds,
    HealthStatus, MetricsMonitor, MetricsSnapshot, health_check,
};

/// Version of the SWE-agent library
pub const VERSION: &str = "1.1.0";

/// Get the agent version information string
pub fn get_agent_version_info() -> String {
    format!("SWE-agent Rust implementation version {}", VERSION)
}

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_version() -> String {
    VERSION.to_string()
}
