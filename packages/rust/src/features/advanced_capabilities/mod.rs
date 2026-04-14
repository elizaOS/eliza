//! Advanced Capabilities - Extended features for agent operation.
//!
//! This module provides advanced capabilities that can be enabled with
//! `advanced_capabilities: true` or `enable_extended: true`:
//! - Extended actions (contacts, room management, image generation, etc.)
//! - Extended providers (facts, knowledge, relationships, etc.)
//! - Evaluators (reflection, relationship extraction)
//! - Extended services (relationships, follow-up scheduling)
//! - Experience tracking and learning
//! - Form-based user journeys
//! - Task clipboard / working memory
//! - Personality evolution and per-user preferences
//!
//! These capabilities are re-exported from the basic_capabilities module for organizational clarity.

pub mod clipboard;
pub mod experience;
pub mod form;
pub mod personality;

// Re-export advanced capabilities from basic_capabilities
pub use crate::basic_capabilities::actions::{
    extended_actions as advanced_actions, AddContactAction, FollowRoomAction, GenerateImageAction,
    MuteRoomAction, RemoveContactAction, ScheduleFollowUpAction, SearchContactsAction,
    SendMessageAction, ThinkAction, UnfollowRoomAction, UnmuteRoomAction, UpdateContactAction,
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
pub use crate::basic_capabilities::services::{FollowUpService, RelationshipsService};

/// Get all advanced capabilities as vectors, including the new built-in
/// capabilities (experience, form, clipboard, personality).
pub fn get_advanced_capabilities() -> (
    Vec<Box<dyn crate::basic_capabilities::actions::Action>>,
    Vec<Box<dyn crate::basic_capabilities::providers::Provider>>,
    Vec<Box<dyn Evaluator>>,
) {
    let mut actions = advanced_actions();
    let mut providers = advanced_providers();
    let mut evaluators = advanced_evaluators();

    // Experience
    actions.push(Box::new(experience::RecordExperienceAction));
    providers.push(Box::new(experience::ExperienceProvider::new()));
    evaluators.push(Box::new(experience::ExperienceEvaluator::new()));

    // Form
    actions.push(Box::new(form::FormRestoreAction));
    providers.push(Box::new(form::FormContextProvider::new()));
    evaluators.push(Box::new(form::FormExtractorEvaluator::new()));

    // Clipboard
    actions.push(Box::new(clipboard::ClipboardAddAction));
    actions.push(Box::new(clipboard::ClipboardRemoveAction));
    actions.push(Box::new(clipboard::ClipboardClearAction));
    providers.push(Box::new(clipboard::ClipboardProvider::new()));

    // Personality
    actions.push(Box::new(personality::ModifyCharacterAction));
    providers.push(Box::new(personality::UserPersonalityProvider::new()));
    evaluators.push(Box::new(personality::CharacterEvolutionEvaluator::new()));

    (actions, providers, evaluators)
}
