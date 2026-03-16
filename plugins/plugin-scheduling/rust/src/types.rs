//! Type definitions for the scheduling plugin.
//!
//! Key concepts:
//! - `AvailabilityWindow`: A recurring time slot (e.g., "Mondays 9am-5pm")
//! - `SchedulingRequest`: A request to find a meeting time for multiple participants
//! - `Meeting`: A scheduled event with time, location, and participants
//! - `CalendarEvent`: An ICS-compatible event for calendar invites

use serde::{Deserialize, Serialize};

// ============================================================================
// TIME AND AVAILABILITY
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DayOfWeek {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl DayOfWeek {
    pub fn as_str(&self) -> &'static str {
        match self {
            DayOfWeek::Mon => "mon",
            DayOfWeek::Tue => "tue",
            DayOfWeek::Wed => "wed",
            DayOfWeek::Thu => "thu",
            DayOfWeek::Fri => "fri",
            DayOfWeek::Sat => "sat",
            DayOfWeek::Sun => "sun",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            DayOfWeek::Mon => "Monday",
            DayOfWeek::Tue => "Tuesday",
            DayOfWeek::Wed => "Wednesday",
            DayOfWeek::Thu => "Thursday",
            DayOfWeek::Fri => "Friday",
            DayOfWeek::Sat => "Saturday",
            DayOfWeek::Sun => "Sunday",
        }
    }

    pub fn from_chrono_weekday(weekday: chrono::Weekday) -> Self {
        match weekday {
            chrono::Weekday::Mon => DayOfWeek::Mon,
            chrono::Weekday::Tue => DayOfWeek::Tue,
            chrono::Weekday::Wed => DayOfWeek::Wed,
            chrono::Weekday::Thu => DayOfWeek::Thu,
            chrono::Weekday::Fri => DayOfWeek::Fri,
            chrono::Weekday::Sat => DayOfWeek::Sat,
            chrono::Weekday::Sun => DayOfWeek::Sun,
        }
    }

    pub fn weekdays() -> Vec<DayOfWeek> {
        vec![
            DayOfWeek::Mon,
            DayOfWeek::Tue,
            DayOfWeek::Wed,
            DayOfWeek::Thu,
            DayOfWeek::Fri,
        ]
    }

    pub fn weekends() -> Vec<DayOfWeek> {
        vec![DayOfWeek::Sat, DayOfWeek::Sun]
    }

    pub fn all() -> Vec<DayOfWeek> {
        vec![
            DayOfWeek::Mon,
            DayOfWeek::Tue,
            DayOfWeek::Wed,
            DayOfWeek::Thu,
            DayOfWeek::Fri,
            DayOfWeek::Sat,
            DayOfWeek::Sun,
        ]
    }
}

/// A recurring time window on a specific day of the week.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AvailabilityWindow {
    pub day: DayOfWeek,
    /// Minutes from midnight in local time (0-1439)
    pub start_minutes: u16,
    /// Minutes from midnight in local time (0-1439)
    pub end_minutes: u16,
}

/// A one-off exception to recurring availability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AvailabilityException {
    /// ISO date string (YYYY-MM-DD)
    pub date: String,
    /// If true, completely unavailable this day
    #[serde(default)]
    pub unavailable: bool,
    /// Override start time for this day
    pub start_minutes: Option<u16>,
    /// Override end time for this day
    pub end_minutes: Option<u16>,
    /// Reason for the exception
    pub reason: Option<String>,
}

/// Complete availability for a participant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Availability {
    /// IANA time zone (e.g., "America/New_York")
    pub time_zone: String,
    /// Weekly recurring availability
    #[serde(default)]
    pub weekly: Vec<AvailabilityWindow>,
    /// One-off exceptions
    #[serde(default)]
    pub exceptions: Vec<AvailabilityException>,
}

/// A specific time slot with start and end times.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeSlot {
    /// ISO datetime string
    pub start: String,
    /// ISO datetime string
    pub end: String,
    /// IANA time zone
    pub time_zone: String,
}

// ============================================================================
// PARTICIPANTS
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParticipantRole {
    Organizer,
    Required,
    Optional,
}

/// A participant in a scheduling request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Participant {
    pub entity_id: String,
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub availability: Availability,
    #[serde(default = "default_priority")]
    pub priority: u8,
}

fn default_priority() -> u8 {
    1
}

/// A participant in a meeting with RSVP status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingParticipant {
    pub entity_id: String,
    pub name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub role: ParticipantRole,
    #[serde(default)]
    pub confirmed: bool,
    pub confirmed_at: Option<i64>,
    pub decline_reason: Option<String>,
}

// ============================================================================
// MEETING LOCATION
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocationType {
    InPerson,
    Virtual,
    Phone,
}

/// Location details for a meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingLocation {
    #[serde(rename = "type")]
    pub location_type: LocationType,
    pub name: Option<String>,
    pub address: Option<String>,
    pub city: Option<String>,
    pub place_id: Option<String>,
    pub video_url: Option<String>,
    pub phone_number: Option<String>,
    pub notes: Option<String>,
}

// ============================================================================
// SCHEDULING REQUEST
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchedulingUrgency {
    Flexible,
    Soon,
    Urgent,
}

/// Constraints for finding a meeting time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulingConstraints {
    #[serde(default = "default_min_duration")]
    pub min_duration_minutes: u32,
    #[serde(default = "default_preferred_duration")]
    pub preferred_duration_minutes: u32,
    #[serde(default = "default_max_days_out")]
    pub max_days_out: u32,
    pub preferred_times: Option<Vec<String>>,
    pub preferred_days: Option<Vec<DayOfWeek>>,
    pub location_type: Option<LocationType>,
    pub location_constraint: Option<String>,
}

fn default_min_duration() -> u32 {
    30
}
fn default_preferred_duration() -> u32 {
    60
}
fn default_max_days_out() -> u32 {
    7
}

impl Default for SchedulingConstraints {
    fn default() -> Self {
        Self {
            min_duration_minutes: 30,
            preferred_duration_minutes: 60,
            max_days_out: 7,
            preferred_times: None,
            preferred_days: None,
            location_type: None,
            location_constraint: None,
        }
    }
}

/// A request to find a meeting time for participants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulingRequest {
    pub id: String,
    pub room_id: String,
    pub title: String,
    pub description: Option<String>,
    pub participants: Vec<Participant>,
    pub constraints: SchedulingConstraints,
    #[serde(default = "default_urgency")]
    pub urgency: SchedulingUrgency,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default = "default_max_proposals")]
    pub max_proposals: u32,
}

fn default_urgency() -> SchedulingUrgency {
    SchedulingUrgency::Flexible
}
fn default_max_proposals() -> u32 {
    3
}

// ============================================================================
// MEETING
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingStatus {
    Proposed,
    Confirmed,
    Scheduled,
    InProgress,
    Completed,
    Cancelled,
    Rescheduling,
    NoShow,
}

/// A scheduled meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Meeting {
    pub id: String,
    pub request_id: String,
    pub room_id: String,
    pub title: String,
    pub description: Option<String>,
    pub slot: TimeSlot,
    pub location: MeetingLocation,
    pub participants: Vec<MeetingParticipant>,
    pub status: MeetingStatus,
    #[serde(default)]
    pub reschedule_count: u32,
    pub cancellation_reason: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    pub notes: Option<String>,
    pub meta: Option<serde_json::Value>,
}

// ============================================================================
// CALENDAR INTEGRATION
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalendarEventOrganizer {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalendarEventAttendee {
    pub name: String,
    pub email: String,
    pub role: ParticipantRole,
}

/// An ICS-compatible calendar event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub uid: String,
    pub title: String,
    pub description: Option<String>,
    pub start: String,
    pub end: String,
    pub time_zone: String,
    pub location: Option<String>,
    pub organizer: Option<CalendarEventOrganizer>,
    pub attendees: Option<Vec<CalendarEventAttendee>>,
    pub url: Option<String>,
    pub reminder_minutes: Option<Vec<u32>>,
}

/// A complete calendar invite ready to send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalendarInvite {
    pub ics: String,
    pub event: CalendarEvent,
    pub recipient_email: String,
    pub recipient_name: String,
}

// ============================================================================
// REMINDERS
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderType {
    Sms,
    Email,
    Whatsapp,
    Push,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReminderStatus {
    Pending,
    Sent,
    Failed,
    Cancelled,
}

/// A scheduled reminder for a meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reminder {
    pub id: String,
    pub meeting_id: String,
    pub participant_id: String,
    pub scheduled_for: String,
    #[serde(rename = "type")]
    pub reminder_type: ReminderType,
    pub message: String,
    #[serde(default = "default_reminder_status")]
    pub status: ReminderStatus,
    pub sent_at: Option<i64>,
    pub error: Option<String>,
    #[serde(default)]
    pub created_at: i64,
}

fn default_reminder_status() -> ReminderStatus {
    ReminderStatus::Pending
}

// ============================================================================
// SCHEDULING RESULT
// ============================================================================

/// A proposed time slot with scoring.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProposedSlot {
    pub slot: TimeSlot,
    pub score: f64,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub concerns: Vec<String>,
}

/// Result of a scheduling request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulingResult {
    pub success: bool,
    #[serde(default)]
    pub proposed_slots: Vec<ProposedSlot>,
    pub failure_reason: Option<String>,
    pub conflicting_participants: Option<Vec<String>>,
}
