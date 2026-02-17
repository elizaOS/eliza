// advanced_capabilities/actions/mod.rs
pub mod add_contact;
pub mod follow_room;
pub mod image_generation;
pub mod mute_room;
pub mod remove_contact;
pub mod roles;
pub mod search_contacts;
pub mod send_message;
pub mod settings;
pub mod unfollow_room;
pub mod unmute_room;
pub mod update_contact;
pub mod update_entity;

pub use add_contact::AddContactAction;
pub use follow_room::FollowRoomAction;
pub use image_generation::GenerateImageAction;
pub use mute_room::MuteRoomAction;
pub use remove_contact::RemoveContactAction;
pub use roles::UpdateRoleAction;
pub use search_contacts::SearchContactsAction;
pub use send_message::SendMessageAction;
pub use settings::UpdateSettingsAction;
pub use unfollow_room::UnfollowRoomAction;
pub use unmute_room::UnmuteRoomAction;
pub use update_contact::UpdateContactAction;
pub use update_entity::UpdateEntityAction;
