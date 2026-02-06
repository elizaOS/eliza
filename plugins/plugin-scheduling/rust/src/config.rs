//! Configuration for the scheduling plugin.

use serde::{Deserialize, Serialize};

/// Configuration for the SchedulingService.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulingServiceConfig {
    /// Default reminder times (minutes before meeting)
    pub default_reminder_minutes: Vec<u32>,
    /// Maximum proposals per scheduling request
    pub max_proposals: u32,
    /// How many days out to look for availability
    pub default_max_days_out: u32,
    /// Minimum meeting duration in minutes
    pub min_meeting_duration: u32,
    /// Default meeting duration in minutes
    pub default_meeting_duration: u32,
    /// Whether to auto-send calendar invites
    pub auto_send_calendar_invites: bool,
    /// Whether to auto-schedule reminders
    pub auto_schedule_reminders: bool,
}

impl Default for SchedulingServiceConfig {
    fn default() -> Self {
        Self {
            default_reminder_minutes: vec![1440, 120], // 24 hours, 2 hours
            max_proposals: 3,
            default_max_days_out: 7,
            min_meeting_duration: 30,
            default_meeting_duration: 60,
            auto_send_calendar_invites: true,
            auto_schedule_reminders: true,
        }
    }
}
