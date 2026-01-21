//! elizaOS Bootstrap Plugin - Rust implementation.
//!
//! This crate provides the core bootstrap functionality for elizaOS agents,
//! including actions, providers, evaluators, and services.
//!
//! # Features
//!
//! - **Actions**: REPLY, IGNORE, FOLLOW_ROOM, MUTE_ROOM, etc.
//! - **Providers**: CHARACTER, RECENT_MESSAGES, WORLD, etc.
//! - **Evaluators**: REFLECTION (extended capability)
//! - **Services**: Task management, Embedding
//!
//! # Usage
//!
//! ```rust,ignore
//! use elizaos_plugin_bootstrap::{BootstrapPlugin, CapabilityConfig};
//!
//! // Default (basic capabilities only)
//! let plugin = BootstrapPlugin::new();
//!
//! // With extended capabilities
//! let plugin = BootstrapPlugin::with_config(CapabilityConfig::with_extended());
//!
//! runtime.register_plugin(plugin).await?;
//! ```

pub mod actions;
#[cfg(feature = "autonomy")]
pub mod autonomy;
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
pub use types::CapabilityConfig;

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
    /// Capability configuration
    config: CapabilityConfig,
}

impl BootstrapPlugin {
    /// Create a new Bootstrap Plugin instance with default configuration (basic capabilities only).
    pub fn new() -> Self {
        Self::with_config(CapabilityConfig::default())
    }

    /// Create a Bootstrap Plugin with the specified capability configuration.
    pub fn with_config(config: CapabilityConfig) -> Self {
        let actions = get_actions(&config);
        let providers = get_providers(&config);
        let evaluators = get_evaluators(&config);

        Self {
            name: "bootstrap",
            description: "elizaOS Bootstrap Plugin - Rust implementation of core agent actions, providers, evaluators, and services",
            actions,
            providers,
            evaluators,
            config,
        }
    }

    /// Initialize the plugin with a runtime.
    pub async fn init(&self, runtime: Arc<dyn IAgentRuntime>) -> PluginResult<()> {
        runtime.log_info("plugin:bootstrap", "Initializing Bootstrap plugin");

        // Initialize services only if basic capabilities are enabled
        if !self.config.disable_basic {
            let mut task_service = services::TaskService::new();
            task_service.start(runtime.clone()).await?;

            let mut embedding_service = services::EmbeddingService::new();
            embedding_service.start(runtime.clone()).await?;
        }

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

// ============================================================================
// Capability-based component getters
// ============================================================================

/// Get actions based on capability config.
fn get_actions(config: &CapabilityConfig) -> Vec<Box<dyn Action>> {
    let mut result = Vec::new();

    if !config.disable_basic {
        result.extend(basic_actions());
    }
    if config.enable_extended {
        result.extend(extended_actions());
    }
    if config.enable_autonomy {
        #[cfg(feature = "autonomy")]
        {
            result.extend(autonomy_actions());
        }
    }

    result
}

/// Get providers based on capability config.
fn get_providers(config: &CapabilityConfig) -> Vec<Box<dyn Provider>> {
    let mut result = Vec::new();

    if !config.disable_basic {
        let mut basic = basic_providers();
        // Filter out character provider if skip_character_provider is set
        if config.skip_character_provider {
            basic.retain(|p| p.name() != "CHARACTER");
        }
        result.extend(basic);
    }
    if config.enable_extended {
        result.extend(extended_providers());
    }
    if config.enable_autonomy {
        #[cfg(feature = "autonomy")]
        {
            result.extend(autonomy_providers());
        }
    }

    result
}

/// Get evaluators based on capability config.
fn get_evaluators(config: &CapabilityConfig) -> Vec<Box<dyn Evaluator>> {
    let mut result = Vec::new();

    if !config.disable_basic {
        result.extend(basic_evaluators());
    }
    if config.enable_extended {
        result.extend(extended_evaluators());
    }
    // Autonomy has no evaluators currently

    result
}

// ============================================================================
// Basic capabilities - included by default
// ============================================================================

/// Basic actions: REPLY, IGNORE, NONE
fn basic_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(actions::ReplyAction),
        Box::new(actions::IgnoreAction),
        Box::new(actions::NoneAction),
    ]
}

/// Basic providers: core context providers
fn basic_providers() -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(providers::ActionsProvider),
        Box::new(providers::ActionStateProvider),
        Box::new(providers::AttachmentsProvider),
        Box::new(providers::CapabilitiesProvider),
        Box::new(providers::CharacterProvider),
        Box::new(providers::EntitiesProvider),
        Box::new(providers::EvaluatorsProvider),
        Box::new(providers::ProvidersListProvider),
        Box::new(providers::RecentMessagesProvider),
        Box::new(providers::CurrentTimeProvider),
        Box::new(providers::WorldProvider),
    ]
}

/// Basic evaluators: none by default
fn basic_evaluators() -> Vec<Box<dyn Evaluator>> {
    vec![]
}

// ============================================================================
// Extended capabilities - opt-in
// ============================================================================

/// Extended actions: CHOICE, FOLLOW/UNFOLLOW, MUTE/UNMUTE, contacts, etc.
fn extended_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(actions::AddContactAction),
        Box::new(actions::ChooseOptionAction),
        Box::new(actions::FollowRoomAction),
        Box::new(actions::GenerateImageAction),
        Box::new(actions::MuteRoomAction),
        Box::new(actions::RemoveContactAction),
        Box::new(actions::ScheduleFollowUpAction),
        Box::new(actions::SearchContactsAction),
        Box::new(actions::SendMessageAction),
        Box::new(actions::UnfollowRoomAction),
        Box::new(actions::UnmuteRoomAction),
        Box::new(actions::UpdateContactAction),
        Box::new(actions::UpdateEntityAction),
        Box::new(actions::UpdateRoleAction),
        Box::new(actions::UpdateSettingsAction),
    ]
}

/// Extended providers: FACTS, ROLES, RELATIONSHIPS, CONTACTS, etc.
fn extended_providers() -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(providers::AgentSettingsProvider),
        Box::new(providers::ChoiceProvider),
        Box::new(providers::ContactsProvider),
        Box::new(providers::FactsProvider),
        Box::new(providers::FollowUpsProvider),
        Box::new(providers::KnowledgeProvider),
        Box::new(providers::RelationshipsProvider),
        Box::new(providers::RolesProvider),
    ]
}

/// Extended evaluators: REFLECTION, RELATIONSHIP_EXTRACTION
fn extended_evaluators() -> Vec<Box<dyn Evaluator>> {
    vec![
        Box::new(evaluators::ReflectionEvaluator),
        Box::new(evaluators::RelationshipExtractionEvaluator),
    ]
}

// ============================================================================
// Autonomy capabilities - opt-in
// ============================================================================

/// Autonomy actions: SEND_TO_ADMIN
#[cfg(feature = "autonomy")]
fn autonomy_actions() -> Vec<Box<dyn Action>> {
    vec![Box::new(autonomy::SendToAdminAction)]
}

/// Autonomy providers: ADMIN_CHAT_HISTORY, AUTONOMY_STATUS
#[cfg(feature = "autonomy")]
fn autonomy_providers() -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(autonomy::AdminChatProvider),
        Box::new(autonomy::AutonomyStatusProvider),
    ]
}

/// Prelude module - import directly from specific modules:
/// - actions::Action
/// - error::{PluginError, PluginResult}
/// - evaluators::Evaluator
/// - providers::Provider
/// - runtime::IAgentRuntime
/// - services::{Service, ServiceType}
/// - types::*
pub mod prelude {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_creation_default() {
        let plugin = BootstrapPlugin::new();
        assert_eq!(plugin.name(), "bootstrap");
        // Default has basic capabilities only
        assert_eq!(plugin.actions().len(), 3); // REPLY, IGNORE, NONE
        assert!(!plugin.providers().is_empty());
    }

    #[test]
    fn test_plugin_with_extended() {
        let plugin = BootstrapPlugin::with_config(CapabilityConfig::with_extended());
        // Extended has both basic and extended
        assert!(plugin.actions().len() > 3);
        assert!(plugin.providers().len() > 11);
    }

    #[test]
    fn test_plugin_extended_only() {
        let plugin = BootstrapPlugin::with_config(CapabilityConfig::extended_only());
        // Only extended (no basic actions like REPLY)
        assert!(!plugin.actions().iter().any(|a| a.name() == "REPLY"));
        assert!(plugin.actions().iter().any(|a| a.name() == "CHOOSE_OPTION"));
    }

    #[test]
    fn test_plugin_disable_basic() {
        let plugin = BootstrapPlugin::with_config(CapabilityConfig {
            disable_basic: true,
            enable_extended: false,
            skip_character_provider: false,
        });
        // No capabilities
        assert!(plugin.actions().is_empty());
        assert!(plugin.providers().is_empty());
    }

    #[test]
    fn test_plugin_skip_character_provider() {
        let plugin = BootstrapPlugin::with_config(CapabilityConfig::anonymous());
        // Should have providers but no CHARACTER provider
        assert!(!plugin.providers().is_empty());
        assert!(!plugin.providers().iter().any(|p| p.name() == "CHARACTER"));
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
    fn test_all_actions_have_descriptions() {
        let plugin = BootstrapPlugin::with_config(CapabilityConfig::with_extended());

        for action in plugin.actions() {
            assert!(!action.name().is_empty());
            assert!(!action.description().is_empty());
        }
    }

    #[test]
    fn test_all_providers_have_descriptions() {
        let plugin = BootstrapPlugin::with_config(CapabilityConfig::with_extended());

        for provider in plugin.providers() {
            assert!(!provider.name().is_empty());
            assert!(!provider.description().is_empty());
        }
    }

    #[test]
    fn test_capability_config_constructors() {
        let basic = CapabilityConfig::basic_only();
        assert!(!basic.disable_basic);
        assert!(!basic.enable_extended);

        let extended = CapabilityConfig::with_extended();
        assert!(!extended.disable_basic);
        assert!(extended.enable_extended);

        let extended_only = CapabilityConfig::extended_only();
        assert!(extended_only.disable_basic);
        assert!(extended_only.enable_extended);
    }
}
