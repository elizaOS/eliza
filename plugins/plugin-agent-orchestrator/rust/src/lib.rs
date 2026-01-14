//! Agent Orchestrator Plugin for ElizaOS.
//!
//! Orchestrates tasks across registered agent providers without performing
//! file I/O directly - that responsibility belongs to sub-agent workers.

pub mod actions;
pub mod config;
pub mod error;
pub mod providers;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use config::{configure_agent_orchestrator_plugin, get_configured_options, AgentOrchestratorPluginOptions};
pub use error::OrchestratorError;
pub use service::AgentOrchestratorService;
pub use types::*;

/// Plugin definition for ElizaOS
pub fn create_plugin() -> Plugin {
    Plugin {
        name: "agent-orchestrator".to_string(),
        description: "Orchestrates tasks across registered agent providers".to_string(),
        services: vec!["CODE_TASK".to_string()],
        actions: vec![
            "CREATE_TASK".to_string(),
            "LIST_TASKS".to_string(),
            "SWITCH_TASK".to_string(),
            "SEARCH_TASKS".to_string(),
            "PAUSE_TASK".to_string(),
            "RESUME_TASK".to_string(),
            "CANCEL_TASK".to_string(),
        ],
        providers: vec!["TASK_CONTEXT".to_string()],
    }
}

/// Plugin metadata
#[derive(Debug, Clone)]
pub struct Plugin {
    pub name: String,
    pub description: String,
    pub services: Vec<String>,
    pub actions: Vec<String>,
    pub providers: Vec<String>,
}
