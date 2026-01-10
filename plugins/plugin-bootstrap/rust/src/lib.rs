//! elizaOS Bootstrap Plugin - Rust implementation.
//!
//! This crate provides the core bootstrap functionality for elizaOS agents,
//! including actions, providers, evaluators, and services.
//!
//! # Features
//!
//! - **Actions**: REPLY, IGNORE, FOLLOW_ROOM, MUTE_ROOM, etc.
//! - **Providers**: CHARACTER, RECENT_MESSAGES, WORLD, etc.
//! - **Evaluators**: GOAL, REFLECTION
//! - **Services**: Task management, Embedding
//!
//! # Usage
//!
//! ```rust,ignore
//! use elizaos_plugin_bootstrap::BootstrapPlugin;
//!
//! let plugin = BootstrapPlugin::new();
//! runtime.register_plugin(plugin).await?;
//! ```

pub mod actions;
pub mod error;
pub mod evaluators;
pub mod providers;
pub mod runtime;
pub mod services;
pub mod types;
pub mod xml;

use actions::Action;
use error::PluginResult;
use evaluators::Evaluator;
use providers::Provider;
use runtime::IAgentRuntime;
use services::Service;
use std::sync::Arc;

/// The Bootstrap Plugin.
///
/// Provides core agent capabilities including actions, providers,
/// evaluators, and services.
pub struct BootstrapPlugin {
    /// Plugin name
    pub name: &'static str,
    /// Plugin description
    pub description: &'static str,
    /// Available actions
    pub actions: Vec<Box<dyn Action>>,
    /// Available providers
    pub providers: Vec<Box<dyn Provider>>,
    /// Available evaluators
    pub evaluators: Vec<Box<dyn Evaluator>>,
}

impl BootstrapPlugin {
    /// Create a new Bootstrap Plugin instance.
    pub fn new() -> Self {
        Self {
            name: "@elizaos/plugin-bootstrap",
            description: "elizaOS Bootstrap Plugin - Rust implementation of core agent actions, providers, evaluators, and services",
            actions: actions::all_actions(),
            providers: providers::all_providers(),
            evaluators: evaluators::all_evaluators(),
        }
    }

    /// Initialize the plugin with a runtime.
    pub async fn init(&self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info(
            "plugin:bootstrap",
            "Initializing Bootstrap plugin",
        );

        // Initialize services
        let mut task_service = services::TaskService::new();
        task_service.start(runtime.clone()).await?;

        let mut embedding_service = services::EmbeddingService::new();
        embedding_service.start(runtime.clone()).await?;

        runtime.log_info(
            "plugin:bootstrap",
            &format!(
                "Bootstrap plugin initialized: {} actions, {} providers, {} evaluators",
                self.actions.len(),
                self.providers.len(),
                self.evaluators.len()
            ),
        );

        Ok(())
    }

    /// Get the plugin name.
    pub fn name(&self) -> &'static str {
        self.name
    }

    /// Get the plugin description.
    pub fn description(&self) -> &'static str {
        self.description
    }

    /// Get all actions.
    pub fn actions(&self) -> &[Box<dyn Action>] {
        &self.actions
    }

    /// Get all providers.
    pub fn providers(&self) -> &[Box<dyn Provider>] {
        &self.providers
    }

    /// Get all evaluators.
    pub fn evaluators(&self) -> &[Box<dyn Evaluator>] {
        &self.evaluators
    }

    /// Find an action by name.
    pub fn get_action(&self, name: &str) -> Option<&dyn Action> {
        self.actions
            .iter()
            .find(|a| a.name() == name || a.similes().contains(&name))
            .map(|a| a.as_ref())
    }

    /// Find a provider by name.
    pub fn get_provider(&self, name: &str) -> Option<&dyn Provider> {
        self.providers
            .iter()
            .find(|p| p.name() == name)
            .map(|p| p.as_ref())
    }

    /// Find an evaluator by name.
    pub fn get_evaluator(&self, name: &str) -> Option<&dyn Evaluator> {
        self.evaluators
            .iter()
            .find(|e| e.name() == name)
            .map(|e| e.as_ref())
    }
}

impl Default for BootstrapPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// Re-export commonly used types.
pub mod prelude {
    pub use crate::actions::Action;
    pub use crate::error::{PluginError, PluginResult};
    pub use crate::evaluators::Evaluator;
    pub use crate::providers::Provider;
    pub use crate::runtime::IAgentRuntime;
    pub use crate::services::{Service, ServiceType};
    pub use crate::types::*;
    pub use crate::BootstrapPlugin;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_creation() {
        let plugin = BootstrapPlugin::new();
        assert_eq!(plugin.name(), "@elizaos/plugin-bootstrap");
        assert!(!plugin.actions().is_empty());
        assert!(!plugin.providers().is_empty());
        assert!(!plugin.evaluators().is_empty());
    }

    #[test]
    fn test_get_action_by_name() {
        let plugin = BootstrapPlugin::new();
        
        let reply = plugin.get_action("REPLY");
        assert!(reply.is_some());
        assert_eq!(reply.unwrap().name(), "REPLY");

        let ignore = plugin.get_action("IGNORE");
        assert!(ignore.is_some());
    }

    #[test]
    fn test_get_action_by_simile() {
        let plugin = BootstrapPlugin::new();
        
        // RESPOND is a simile for REPLY
        let reply = plugin.get_action("RESPOND");
        assert!(reply.is_some());
        assert_eq!(reply.unwrap().name(), "REPLY");
    }

    #[test]
    fn test_get_provider() {
        let plugin = BootstrapPlugin::new();
        
        let character = plugin.get_provider("CHARACTER");
        assert!(character.is_some());
        assert_eq!(character.unwrap().name(), "CHARACTER");
    }

    #[test]
    fn test_get_evaluator() {
        let plugin = BootstrapPlugin::new();
        
        let goal = plugin.get_evaluator("GOAL");
        assert!(goal.is_some());
        assert_eq!(goal.unwrap().name(), "GOAL");
    }

    #[test]
    fn test_all_actions_have_descriptions() {
        let plugin = BootstrapPlugin::new();
        
        for action in plugin.actions() {
            assert!(!action.name().is_empty());
            assert!(!action.description().is_empty());
        }
    }

    #[test]
    fn test_all_providers_have_descriptions() {
        let plugin = BootstrapPlugin::new();
        
        for provider in plugin.providers() {
            assert!(!provider.name().is_empty());
            assert!(!provider.description().is_empty());
        }
    }

    #[test]
    fn test_all_evaluators_have_descriptions() {
        let plugin = BootstrapPlugin::new();
        
        for evaluator in plugin.evaluators() {
            assert!(!evaluator.name().is_empty());
            assert!(!evaluator.description().is_empty());
        }
    }
}

