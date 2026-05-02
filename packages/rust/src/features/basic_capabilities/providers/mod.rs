// basic_capabilities/providers/mod.rs
pub mod action_state;
pub mod actions;
pub mod attachments;
pub mod capabilities;
pub mod character;
pub mod choice;
pub mod context_bench;
pub mod current_time;
pub mod entities;
pub mod evaluators_list;
pub mod prompt_compression;
pub mod providers_list;
pub mod recent_messages;
pub mod time;
pub mod world;

pub use action_state::ActionStateProvider;
pub use actions::ActionsProvider;
pub use attachments::AttachmentsProvider;
pub use capabilities::CapabilitiesProvider;
pub use character::CharacterProvider;
pub use choice::ChoiceProvider;
pub use context_bench::ContextBenchProvider;
pub use current_time::CurrentTimeProvider;
pub use entities::EntitiesProvider;
pub use evaluators_list::EvaluatorsProvider;
pub use providers_list::ProvidersListProvider;
pub use recent_messages::RecentMessagesProvider;
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

    /// Whether this provider is dynamic.
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
