//! Basic Capabilities - Core functionality for agent operation.
//!
//! This module provides the fundamental capabilities needed for basic agent operation:
//! - Core actions (choice, reply, ignore, none)
//! - Core providers (actions, character, entities, messages, etc.)
//! - Essential services (task management, embeddings)
//!
//! These capabilities are re-exported from the bootstrap module for organizational clarity.

// Re-export basic capabilities from bootstrap
pub use crate::bootstrap::actions::{
    basic_actions, Action, ChooseOptionAction, IgnoreAction, NoneAction, ReplyAction,
};
pub use crate::bootstrap::evaluators::basic_evaluators;
pub use crate::bootstrap::providers::{
    basic_providers, ActionStateProvider, ActionsProvider, AttachmentsProvider,
    CapabilitiesProvider, CharacterProvider, ChoiceProvider, ContextBenchProvider,
    CurrentTimeProvider, EntitiesProvider, EvaluatorsProvider, Provider, ProvidersListProvider,
    RecentMessagesProvider, TimeProvider, WorldProvider,
};
pub use crate::bootstrap::services::{EmbeddingService, Service, ServiceType, TaskService};

/// Get all basic capabilities as vectors.
pub fn get_basic_capabilities() -> (
    Vec<Box<dyn Action>>,
    Vec<Box<dyn Provider>>,
    Vec<Box<dyn crate::bootstrap::evaluators::Evaluator>>,
) {
    (basic_actions(), basic_providers(), basic_evaluators())
}
