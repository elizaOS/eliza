//! Providers module for the elizaOS Bootstrap Plugin.
//!
//! This module contains all provider implementations.

mod action_state;
mod actions;
mod agent_settings;
mod attachments;
mod capabilities;
mod character;
mod choice;
mod current_time;
mod entities;
mod evaluators_list;
mod facts;
mod knowledge;
mod providers_list;
mod recent_messages;
mod relationships;
mod roles;
mod world;

pub use action_state::ActionStateProvider;
pub use actions::ActionsProvider;
pub use agent_settings::AgentSettingsProvider;
pub use attachments::AttachmentsProvider;
pub use capabilities::CapabilitiesProvider;
pub use character::CharacterProvider;
pub use choice::ChoiceProvider;
pub use current_time::CurrentTimeProvider;
pub use entities::EntitiesProvider;
pub use evaluators_list::EvaluatorsProvider;
pub use facts::FactsProvider;
pub use knowledge::KnowledgeProvider;
pub use providers_list::ProvidersListProvider;
pub use recent_messages::RecentMessagesProvider;
pub use relationships::RelationshipsProvider;
pub use roles::RolesProvider;
pub use world::WorldProvider;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{Memory, ProviderResult, State};
use async_trait::async_trait;

/// Trait that all providers must implement.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Get the provider name.
    fn name(&self) -> &'static str;

    /// Get provider description.
    fn description(&self) -> &'static str;

    /// Whether this provider is dynamic (changes frequently).
    fn is_dynamic(&self) -> bool {
        true
    }

    /// Get the provider context.
    async fn get(
        &self,
        runtime: &dyn IAgentRuntime,
        message: &Memory,
        state: Option<&State>,
    ) -> PluginResult<ProviderResult>;
}

/// Get all available providers.
pub fn all_providers() -> Vec<Box<dyn Provider>> {
    vec![
        // Core providers (order matters for prompt composition)
        Box::new(CharacterProvider),
        Box::new(CurrentTimeProvider),
        // Context providers
        Box::new(RecentMessagesProvider),
        Box::new(EntitiesProvider),
        Box::new(RelationshipsProvider),
        Box::new(FactsProvider),
        Box::new(KnowledgeProvider),
        Box::new(WorldProvider),
        // State providers
        Box::new(ActionStateProvider),
        Box::new(AgentSettingsProvider),
        // Capability providers
        Box::new(ActionsProvider),
        Box::new(CapabilitiesProvider),
        Box::new(EvaluatorsProvider),
        Box::new(ProvidersListProvider),
        // Dynamic providers
        Box::new(AttachmentsProvider),
        Box::new(ChoiceProvider),
        Box::new(RolesProvider),
    ]
}
