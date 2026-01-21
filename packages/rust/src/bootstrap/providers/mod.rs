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
mod contacts;
mod context_bench;
mod current_time;
mod entities;
mod evaluators_list;
mod facts;
mod follow_ups;
mod knowledge;
mod providers_list;
mod recent_messages;
mod relationships;
mod roles;
mod settings;
mod time;
mod world;

pub use action_state::ActionStateProvider;
pub use actions::ActionsProvider;
pub use agent_settings::AgentSettingsProvider;
pub use attachments::AttachmentsProvider;
pub use capabilities::CapabilitiesProvider;
pub use character::CharacterProvider;
pub use choice::ChoiceProvider;
pub use contacts::ContactsProvider;
pub use context_bench::ContextBenchProvider;
pub use current_time::CurrentTimeProvider;
pub use entities::EntitiesProvider;
pub use evaluators_list::EvaluatorsProvider;
pub use facts::FactsProvider;
pub use follow_ups::FollowUpsProvider;
pub use knowledge::KnowledgeProvider;
pub use providers_list::ProvidersListProvider;
pub use recent_messages::RecentMessagesProvider;
pub use relationships::RelationshipsProvider;
pub use roles::RolesProvider;
pub use settings::SettingsProvider;
pub use time::TimeProvider;
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

/// Get basic providers (always available).
pub fn basic_providers() -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(CharacterProvider),
        Box::new(CurrentTimeProvider),
        Box::new(TimeProvider),
        Box::new(ContextBenchProvider),
        Box::new(RecentMessagesProvider),
        Box::new(EntitiesProvider),
        Box::new(ActionStateProvider),
        Box::new(ActionsProvider),
        Box::new(CapabilitiesProvider),
        Box::new(EvaluatorsProvider),
        Box::new(ProvidersListProvider),
        Box::new(AttachmentsProvider),
        Box::new(WorldProvider),
        Box::new(ChoiceProvider),
    ]
}

/// Get extended providers (opt-in).
pub fn extended_providers() -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(ContactsProvider),
        Box::new(FactsProvider),
        Box::new(FollowUpsProvider),
        Box::new(KnowledgeProvider),
        Box::new(RelationshipsProvider),
        Box::new(RolesProvider),
        Box::new(AgentSettingsProvider),
        Box::new(SettingsProvider),
    ]
}

/// Get all available providers.
pub fn all_providers() -> Vec<Box<dyn Provider>> {
    let mut providers = basic_providers();
    providers.extend(extended_providers());
    providers
}
