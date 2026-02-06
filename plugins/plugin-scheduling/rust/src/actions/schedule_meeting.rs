//! SCHEDULE_MEETING action.
//!
//! Finds available slots and proposes meeting times based on user availability.

use regex::Regex;

use crate::types::ProposedSlot;

/// Parsed meeting request from natural language.
#[derive(Debug, Default)]
pub struct ParsedMeetingRequest {
    pub title: Option<String>,
    pub duration: Option<u32>,
    pub urgency: String,
}

/// Parse natural language meeting request into structured data.
pub fn parse_meeting_request(text: &str) -> ParsedMeetingRequest {
    let normalized = text.to_lowercase();
    let mut result = ParsedMeetingRequest {
        urgency: "flexible".to_string(),
        ..Default::default()
    };

    // Try to extract a title
    let title_re = Regex::new(
        r#"(?i)(?:schedule|book|arrange|set up|plan)\s+(?:a\s+)?(?:meeting|call|chat)\s+(?:about|for|regarding|to discuss)\s+["']?([^"'\n.]+)["']?"#
    ).unwrap();
    if let Some(caps) = title_re.captures(text) {
        result.title = Some(caps[1].trim().to_string());
    }

    // Extract duration
    let duration_re = Regex::new(r"(\d+)\s*(?:minute|min|hour|hr)").unwrap();
    if let Some(caps) = duration_re.captures(&normalized) {
        let mut duration: u32 = caps[1].parse().unwrap_or(30);
        if normalized.contains("hour") || normalized.contains("hr") {
            duration *= 60;
        }
        result.duration = Some(duration);
    }

    // Extract urgency
    if normalized.contains("urgent")
        || normalized.contains("asap")
        || normalized.contains("immediately")
    {
        result.urgency = "urgent".to_string();
    } else if normalized.contains("soon") || normalized.contains("this week") {
        result.urgency = "soon".to_string();
    }

    result
}

/// Format proposed slots for display.
pub fn format_proposed_slots(slots: &[ProposedSlot]) -> String {
    if slots.is_empty() {
        return "I couldn't find any available time slots.".to_string();
    }

    let mut formatted: Vec<String> = Vec::new();
    for (index, proposal) in slots.iter().enumerate() {
        let mut entry = format!(
            "{}. {} - {}",
            index + 1,
            proposal.slot.start,
            proposal.slot.end
        );
        if let Some(reason) = proposal.reasons.first() {
            entry.push_str(&format!(" ({})", reason));
        }
        formatted.push(entry);
    }

    format!(
        "Here are some times that work:\n\n{}\n\nWhich option works best for you? Just say the number.",
        formatted.join("\n")
    )
}

/// SCHEDULE_MEETING action metadata and validation.
pub struct ScheduleMeetingAction;

impl ScheduleMeetingAction {
    pub const NAME: &'static str = "SCHEDULE_MEETING";
    pub const SIMILES: &'static [&'static str] = &[
        "BOOK_MEETING",
        "ARRANGE_MEETING",
        "SET_UP_MEETING",
        "PLAN_MEETING",
        "CREATE_MEETING",
    ];
    pub const DESCRIPTION: &'static str =
        "Schedule a meeting between multiple participants by finding a suitable time slot";

    /// Validate if this message should trigger the SCHEDULE_MEETING action.
    pub fn validate(text: &str) -> bool {
        let lower = text.to_lowercase();
        lower.contains("schedule")
            || lower.contains("book")
            || lower.contains("arrange")
            || lower.contains("set up")
            || lower.contains("plan")
            || (lower.contains("meet") && !lower.contains("nice to meet"))
    }
}
