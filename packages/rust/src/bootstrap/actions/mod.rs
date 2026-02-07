//! Actions module for the elizaOS Bootstrap Plugin.
//!
//! This module contains all action implementations.

mod add_contact;
mod choice;
mod follow_room;
mod ignore;
mod image_generation;
mod mute_room;
mod none;
mod remove_contact;
mod reply;
mod roles;
mod schedule_follow_up;
mod search_contacts;
mod send_message;
mod settings;
mod unfollow_room;
mod unmute_room;
mod update_contact;
mod update_entity;

pub use add_contact::AddContactAction;
pub use choice::ChooseOptionAction;
pub use follow_room::FollowRoomAction;
pub use ignore::IgnoreAction;
pub use image_generation::GenerateImageAction;
pub use mute_room::MuteRoomAction;
pub use none::NoneAction;
pub use remove_contact::RemoveContactAction;
pub use reply::ReplyAction;
pub use roles::UpdateRoleAction;
pub use schedule_follow_up::ScheduleFollowUpAction;
pub use search_contacts::SearchContactsAction;
pub use send_message::SendMessageAction;
pub use settings::UpdateSettingsAction;
pub use unfollow_room::UnfollowRoomAction;
pub use unmute_room::UnmuteRoomAction;
pub use update_contact::UpdateContactAction;
pub use update_entity::UpdateEntityAction;

use crate::error::PluginResult;
use crate::runtime::IAgentRuntime;
use crate::types::{ActionResult, Memory, State};
use async_trait::async_trait;
use std::sync::Arc;

/// Trait that all actions must implement.
#[async_trait]
pub trait Action: Send + Sync {
    /// Get the action name.
    fn name(&self) -> &'static str;

    /// Get action similes (alternative names).
    fn similes(&self) -> &[&'static str];

    /// Get action description.
    fn description(&self) -> &'static str;

    /// Validate whether the action can be executed.
    async fn validate(&self, runtime: &dyn IAgentRuntime, message: &Memory) -> bool;

    /// Execute the action.
    async fn handler(
        &self,
        runtime: Arc<dyn IAgentRuntime>,
        message: &Memory,
        state: Option<&State>,
        responses: Option<&[Memory]>,
    ) -> PluginResult<ActionResult>;
}

/// Callback type for action responses.
pub type ActionCallback = Box<dyn Fn(&crate::types::Content) + Send + Sync>;

/// Get basic actions (always available).
pub fn basic_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(ChooseOptionAction),
        Box::new(ReplyAction),
        Box::new(IgnoreAction),
        Box::new(NoneAction),
    ]
}

/// Get extended actions (opt-in).
pub fn extended_actions() -> Vec<Box<dyn Action>> {
    vec![
        Box::new(AddContactAction),
        Box::new(FollowRoomAction),
        Box::new(GenerateImageAction),
        Box::new(MuteRoomAction),
        Box::new(RemoveContactAction),
        Box::new(ScheduleFollowUpAction),
        Box::new(SearchContactsAction),
        Box::new(SendMessageAction),
        Box::new(UnfollowRoomAction),
        Box::new(UnmuteRoomAction),
        Box::new(UpdateContactAction),
        Box::new(UpdateEntityAction),
        Box::new(UpdateRoleAction),
        Box::new(UpdateSettingsAction),
    ]
}

/// Get all available actions.
pub fn all_actions() -> Vec<Box<dyn Action>> {
    let mut actions = basic_actions();
    actions.extend(extended_actions());
    actions
}
