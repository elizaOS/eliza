//! Basic capabilities compatibility surface.
//!
//! The Rust runtime now treats the legacy BasicCapabilities bootstrap modules as
//! internal core capabilities. This module re-exports that implementation under
//! the stable `crate::basic_capabilities::*` paths used throughout the crate.

pub mod bootstrap;

pub use bootstrap::actions;
pub use bootstrap::error;
pub use bootstrap::evaluators;
pub use bootstrap::providers;
pub use bootstrap::runtime;
pub use bootstrap::services;
pub use bootstrap::types;
pub use bootstrap::xml;
pub use bootstrap::{BasicCapabilitiesPlugin, CapabilityConfig};

pub use actions::{
    all_actions, basic_actions, extended_actions, Action, AddContactAction, ChooseOptionAction,
    FollowRoomAction, GenerateImageAction, IgnoreAction, MuteRoomAction, NoneAction,
    RemoveContactAction, ReplyAction, ScheduleFollowUpAction, SearchContactsAction,
    SendMessageAction, UnfollowRoomAction, UnmuteRoomAction, UpdateContactAction,
    UpdateEntityAction, UpdateRoleAction, UpdateSettingsAction,
};
pub use evaluators::{
    all_evaluators, basic_evaluators, extended_evaluators, Evaluator, ReflectionEvaluator,
    RelationshipExtractionEvaluator,
};
pub use providers::{
    all_providers, basic_providers, extended_providers, ActionStateProvider, ActionsProvider,
    AgentSettingsProvider, AttachmentsProvider, CapabilitiesProvider, CharacterProvider,
    ChoiceProvider, ContactsProvider, ContextBenchProvider, CurrentTimeProvider, EntitiesProvider,
    EvaluatorsProvider, FactsProvider, FollowUpsProvider, KnowledgeProvider, Provider,
    ProvidersListProvider, RecentMessagesProvider, RelationshipsProvider, RolesProvider,
    SettingsProvider, TimeProvider, WorldProvider,
};
pub use runtime::{ActionInfo, IAgentRuntime, ModelOutput, ModelParams};
pub use services::{
    EmbeddingService, FollowUpService, RelationshipsService, Service, ServiceType, TaskService,
};

/// Get all basic capabilities as vectors.
pub fn get_basic_capabilities() -> (
    Vec<Box<dyn Action>>,
    Vec<Box<dyn Provider>>,
    Vec<Box<dyn Evaluator>>,
) {
    (basic_actions(), basic_providers(), basic_evaluators())
}
