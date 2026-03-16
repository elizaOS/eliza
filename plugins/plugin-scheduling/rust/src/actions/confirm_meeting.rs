//! CONFIRM_MEETING action.
//!
//! Confirms or declines meeting attendance.

/// CONFIRM_MEETING action metadata and validation.
pub struct ConfirmMeetingAction;

impl ConfirmMeetingAction {
    pub const NAME: &'static str = "CONFIRM_MEETING";
    pub const SIMILES: &'static [&'static str] = &[
        "ACCEPT_MEETING",
        "CONFIRM_ATTENDANCE",
        "RSVP_YES",
        "DECLINE_MEETING",
        "CANCEL_ATTENDANCE",
    ];
    pub const DESCRIPTION: &'static str =
        "Confirm or decline attendance for a scheduled meeting";

    /// Validate if this message should trigger the CONFIRM_MEETING action.
    pub fn validate(text: &str) -> bool {
        let lower = text.to_lowercase();
        (lower.contains("confirm") && lower.contains("meeting"))
            || (lower.contains("accept") && lower.contains("meeting"))
            || (lower.contains("decline") && lower.contains("meeting"))
            || lower.contains("rsvp")
            || lower.contains("i'll be there")
            || lower.contains("i can't make it")
    }

    /// Determine if the message is confirming (true) or declining (false).
    pub fn is_confirming(text: &str) -> bool {
        let lower = text.to_lowercase();
        lower.contains("confirm")
            || lower.contains("accept")
            || lower.contains("i'll be there")
            || lower.contains("yes")
    }
}
