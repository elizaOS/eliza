//! Action modules for the scheduling plugin.

pub mod confirm_meeting;
pub mod schedule_meeting;
pub mod set_availability;

pub use confirm_meeting::ConfirmMeetingAction;
pub use schedule_meeting::ScheduleMeetingAction;
pub use set_availability::SetAvailabilityAction;
