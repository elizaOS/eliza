//! SCHEDULING_CONTEXT provider.
//!
//! Provides the agent with context about upcoming meetings and scheduling requests.

use crate::service::SchedulingService;
use crate::types::{Meeting, MeetingStatus};

/// Format a meeting for display in context.
pub fn format_meeting_for_context(meeting: &Meeting, service: &SchedulingService) -> String {
    let time_str = service.format_slot(&meeting.slot);
    let participants: Vec<&str> = meeting.participants.iter().map(|p| p.name.as_str()).collect();
    let participants_str = participants.join(", ");

    let location_str = match meeting.location.location_type {
        crate::types::LocationType::InPerson => {
            format!("at {}", meeting.location.name.as_deref().unwrap_or("TBD"))
        }
        crate::types::LocationType::Virtual => "virtual meeting".to_string(),
        crate::types::LocationType::Phone => "phone call".to_string(),
    };

    format!(
        "- \"{}\" on {} ({}) with {} [{:?}]",
        meeting.title,
        time_str,
        location_str,
        participants_str,
        meeting.status
    )
}

/// SCHEDULING_CONTEXT provider.
pub struct SchedulingContextProvider;

impl SchedulingContextProvider {
    pub const NAME: &'static str = "SCHEDULING_CONTEXT";
    pub const DESCRIPTION: &'static str =
        "Provides context about upcoming meetings and scheduling requests";

    /// Get scheduling context for an entity.
    pub async fn get(
        service: &SchedulingService,
        entity_id: &str,
    ) -> String {
        let mut sections: Vec<String> = Vec::new();

        match service.get_upcoming_meetings(entity_id).await {
            Ok(meetings) if !meetings.is_empty() => {
                let proposed: Vec<&Meeting> = meetings
                    .iter()
                    .filter(|m| m.status == MeetingStatus::Proposed)
                    .collect();

                let confirmed: Vec<&Meeting> = meetings
                    .iter()
                    .filter(|m| {
                        m.status == MeetingStatus::Confirmed
                            || m.status == MeetingStatus::Scheduled
                    })
                    .collect();

                if !proposed.is_empty() {
                    sections.push("Meetings pending confirmation:".to_string());
                    for meeting in proposed.iter().take(3) {
                        sections.push(format_meeting_for_context(meeting, service));
                    }
                }

                if !confirmed.is_empty() {
                    sections.push("\nUpcoming confirmed meetings:".to_string());
                    for meeting in confirmed.iter().take(5) {
                        sections.push(format_meeting_for_context(meeting, service));
                    }
                }
            }
            _ => {}
        }

        match service.get_availability(entity_id).await {
            Ok(Some(availability)) => {
                let weekly_count = availability.weekly.len();
                let exceptions_count = availability.exceptions.len();
                sections.push(format!(
                    "\nUser has {} recurring availability windows set (timezone: {})",
                    weekly_count, availability.time_zone
                ));
                if exceptions_count > 0 {
                    sections.push(format!(
                        "User has {} availability exceptions",
                        exceptions_count
                    ));
                }
            }
            Ok(None) => {
                sections.push("\nUser has not set their availability yet".to_string());
            }
            Err(_) => {}
        }

        if sections.is_empty() {
            return String::new();
        }

        format!(
            "<scheduling_context>\n{}\n</scheduling_context>",
            sections.join("\n")
        )
    }
}
