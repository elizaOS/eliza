//! Providers module for the elizaOS Bootstrap Plugin.
//!
//! This module contains all provider implementations.

mod action_state;
mod agent_settings;
mod character;
mod current_time;
mod entities;
mod facts;
mod knowledge;
mod recent_messages;
mod world;

pub use action_state::ActionStateProvider;
pub use agent_settings::AgentSettingsProvider;
pub use character::CharacterProvider;
pub use current_time::CurrentTimeProvider;
pub use entities::EntitiesProvider;
pub use facts::FactsProvider;
pub use knowledge::KnowledgeProvider;
pub use recent_messages::RecentMessagesProvider;
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
        Box::new(CharacterProvider),
        Box::new(CurrentTimeProvider),
        Box::new(EntitiesProvider),
        Box::new(KnowledgeProvider),
        Box::new(RecentMessagesProvider),
        Box::new(WorldProvider),
        Box::new(ActionStateProvider),
        Box::new(AgentSettingsProvider),
        Box::new(FactsProvider),
    ]
}

