//! Advanced Capabilities - Extended features for agent operation.
//!
//! This module provides advanced capabilities that can be enabled with
//! `advanced_capabilities: true` or `enable_extended: true`:
//! - Extended actions (contacts, room management, image generation, etc.)
//! - Extended providers (facts, knowledge, relationships, etc.)
//! - Evaluators (reflection, relationship extraction)
//! - Extended services (rolodex, follow-up scheduling)
//!
//! These capabilities are re-exported from the basic_capabilities module for organizational clarity.

// Re-export advanced capabilities from basic_capabilities
pub use crate::basic_capabilities::actions::{
    extended_actions as advanced_actions, AddContactAction, FollowRoomAction, GenerateImageAction,
    MuteRoomAction, RemoveContactAction, ScheduleFollowUpAction, SearchContactsAction,
    SendMessageAction, UnfollowRoomAction, UnmuteRoomAction, UpdateContactAction,
    UpdateEntityAction, UpdateRoleAction, UpdateSettingsAction,
};
pub use crate::basic_capabilities::evaluators::{
    extended_evaluators as advanced_evaluators, Evaluator, ReflectionEvaluator,
    RelationshipExtractionEvaluator,
};
pub use crate::basic_capabilities::providers::{
    extended_providers as advanced_providers, AgentSettingsProvider, ContactsProvider,
    FactsProvider, FollowUpsProvider, KnowledgeProvider, RelationshipsProvider, RolesProvider,
    SettingsProvider,
};
pub use crate::basic_capabilities::services::{FollowUpService, RolodexService};

/// Get all advanced capabilities as vectors.
pub fn get_advanced_capabilities() -> (
    Vec<Box<dyn crate::basic_capabilities::actions::Action>>,
    Vec<Box<dyn crate::basic_capabilities::providers::Provider>>,
    Vec<Box<dyn Evaluator>>,
) {
    (
        advanced_actions(),
        advanced_providers(),
        advanced_evaluators(),
    )
}
