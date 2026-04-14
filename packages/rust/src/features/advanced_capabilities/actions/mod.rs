// advanced_capabilities/actions/mod.rs
pub mod follow_room;
pub mod image_generation;
pub mod mute_room;
pub mod roles;
pub mod settings;
pub mod think;
pub mod unfollow_room;
pub mod unmute_room;

pub use follow_room::FollowRoomAction;
pub use image_generation::GenerateImageAction;
pub use mute_room::MuteRoomAction;
pub use roles::UpdateRoleAction;
pub use settings::UpdateSettingsAction;
pub use think::ThinkAction;
pub use unfollow_room::UnfollowRoomAction;
pub use unmute_room::UnmuteRoomAction;
