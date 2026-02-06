//! Error types for the scheduling plugin.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum SchedulingError {
    #[error("Meeting not found: {meeting_id}")]
    MeetingNotFound { meeting_id: String },

    #[error("Participant {entity_id} not found in meeting {meeting_id}")]
    ParticipantNotFound {
        entity_id: String,
        meeting_id: String,
    },

    #[error("No availability set for entity: {entity_id}")]
    NoAvailability { entity_id: String },

    #[error("Scheduling service is not available: {detail}")]
    ServiceNotAvailable { detail: String },

    #[error("Could not parse availability from: {text}")]
    InvalidAvailability { text: String },

    #[error("Storage error during {operation}: {detail}")]
    Storage { operation: String, detail: String },

    #[error("Invalid time zone: {tz}")]
    InvalidTimeZone { tz: String },

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Parse error: {0}")]
    Parse(String),
}

pub type Result<T> = std::result::Result<T, SchedulingError>;
