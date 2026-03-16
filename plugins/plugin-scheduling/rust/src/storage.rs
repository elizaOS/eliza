//! Component-based persistence for scheduling data.
//!
//! Provides trait-based storage abstractions for availability, meetings,
//! reminders, and scheduling requests. In-memory implementations are
//! provided for testing.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::error::Result;
use crate::types::{Availability, Meeting, MeetingStatus, Reminder, ReminderStatus, SchedulingRequest};

// ============================================================================
// STORAGE TRAITS
// ============================================================================

#[async_trait::async_trait]
pub trait AvailabilityStorage: Send + Sync {
    async fn get(&self, entity_id: &str) -> Result<Option<Availability>>;
    async fn save(&self, entity_id: &str, availability: &Availability) -> Result<()>;
    async fn delete(&self, entity_id: &str) -> Result<()>;
}

#[async_trait::async_trait]
pub trait SchedulingRequestStorage: Send + Sync {
    async fn get(&self, request_id: &str) -> Result<Option<SchedulingRequest>>;
    async fn save(&self, request: &SchedulingRequest) -> Result<()>;
    async fn delete(&self, request_id: &str) -> Result<()>;
    async fn get_by_room(&self, room_id: &str) -> Result<Vec<SchedulingRequest>>;
}

#[async_trait::async_trait]
pub trait MeetingStorage: Send + Sync {
    async fn get(&self, meeting_id: &str) -> Result<Option<Meeting>>;
    async fn save(&self, meeting: &Meeting) -> Result<()>;
    async fn delete(&self, meeting_id: &str) -> Result<()>;
    async fn get_by_room(&self, room_id: &str) -> Result<Vec<Meeting>>;
    async fn get_upcoming_for_participant(&self, entity_id: &str) -> Result<Vec<Meeting>>;
}

#[async_trait::async_trait]
pub trait ReminderStorage: Send + Sync {
    async fn get(&self, reminder_id: &str) -> Result<Option<Reminder>>;
    async fn save(&self, reminder: &Reminder) -> Result<()>;
    async fn delete(&self, reminder_id: &str) -> Result<()>;
    async fn get_by_meeting(&self, meeting_id: &str) -> Result<Vec<Reminder>>;
    async fn get_due(&self) -> Result<Vec<Reminder>>;
}

// ============================================================================
// IN-MEMORY IMPLEMENTATIONS (for testing and standalone use)
// ============================================================================

#[derive(Debug, Default, Clone)]
pub struct InMemoryAvailabilityStorage {
    data: Arc<RwLock<HashMap<String, Availability>>>,
}

impl InMemoryAvailabilityStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl AvailabilityStorage for InMemoryAvailabilityStorage {
    async fn get(&self, entity_id: &str) -> Result<Option<Availability>> {
        let data = self.data.read().await;
        Ok(data.get(entity_id).cloned())
    }

    async fn save(&self, entity_id: &str, availability: &Availability) -> Result<()> {
        let mut data = self.data.write().await;
        data.insert(entity_id.to_string(), availability.clone());
        Ok(())
    }

    async fn delete(&self, entity_id: &str) -> Result<()> {
        let mut data = self.data.write().await;
        data.remove(entity_id);
        Ok(())
    }
}

#[derive(Debug, Default, Clone)]
pub struct InMemorySchedulingRequestStorage {
    data: Arc<RwLock<HashMap<String, SchedulingRequest>>>,
}

impl InMemorySchedulingRequestStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl SchedulingRequestStorage for InMemorySchedulingRequestStorage {
    async fn get(&self, request_id: &str) -> Result<Option<SchedulingRequest>> {
        let data = self.data.read().await;
        Ok(data.get(request_id).cloned())
    }

    async fn save(&self, request: &SchedulingRequest) -> Result<()> {
        let mut data = self.data.write().await;
        data.insert(request.id.clone(), request.clone());
        Ok(())
    }

    async fn delete(&self, request_id: &str) -> Result<()> {
        let mut data = self.data.write().await;
        data.remove(request_id);
        Ok(())
    }

    async fn get_by_room(&self, room_id: &str) -> Result<Vec<SchedulingRequest>> {
        let data = self.data.read().await;
        Ok(data
            .values()
            .filter(|r| r.room_id == room_id)
            .cloned()
            .collect())
    }
}

#[derive(Debug, Default, Clone)]
pub struct InMemoryMeetingStorage {
    data: Arc<RwLock<HashMap<String, Meeting>>>,
}

impl InMemoryMeetingStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl MeetingStorage for InMemoryMeetingStorage {
    async fn get(&self, meeting_id: &str) -> Result<Option<Meeting>> {
        let data = self.data.read().await;
        Ok(data.get(meeting_id).cloned())
    }

    async fn save(&self, meeting: &Meeting) -> Result<()> {
        let mut data = self.data.write().await;
        data.insert(meeting.id.clone(), meeting.clone());
        Ok(())
    }

    async fn delete(&self, meeting_id: &str) -> Result<()> {
        let mut data = self.data.write().await;
        data.remove(meeting_id);
        Ok(())
    }

    async fn get_by_room(&self, room_id: &str) -> Result<Vec<Meeting>> {
        let data = self.data.read().await;
        Ok(data
            .values()
            .filter(|m| m.room_id == room_id)
            .cloned()
            .collect())
    }

    async fn get_upcoming_for_participant(&self, entity_id: &str) -> Result<Vec<Meeting>> {
        let data = self.data.read().await;
        let now = chrono::Utc::now();

        let mut meetings: Vec<Meeting> = data
            .values()
            .filter(|m| {
                m.status != MeetingStatus::Cancelled
                    && m.participants.iter().any(|p| p.entity_id == entity_id)
                    && chrono::DateTime::parse_from_rfc3339(&m.slot.start)
                        .map(|dt| dt > now)
                        .unwrap_or(false)
            })
            .cloned()
            .collect();

        meetings.sort_by(|a, b| a.slot.start.cmp(&b.slot.start));
        Ok(meetings)
    }
}

#[derive(Debug, Default, Clone)]
pub struct InMemoryReminderStorage {
    data: Arc<RwLock<HashMap<String, Reminder>>>,
}

impl InMemoryReminderStorage {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait::async_trait]
impl ReminderStorage for InMemoryReminderStorage {
    async fn get(&self, reminder_id: &str) -> Result<Option<Reminder>> {
        let data = self.data.read().await;
        Ok(data.get(reminder_id).cloned())
    }

    async fn save(&self, reminder: &Reminder) -> Result<()> {
        let mut data = self.data.write().await;
        data.insert(reminder.id.clone(), reminder.clone());
        Ok(())
    }

    async fn delete(&self, reminder_id: &str) -> Result<()> {
        let mut data = self.data.write().await;
        data.remove(reminder_id);
        Ok(())
    }

    async fn get_by_meeting(&self, meeting_id: &str) -> Result<Vec<Reminder>> {
        let data = self.data.read().await;
        Ok(data
            .values()
            .filter(|r| r.meeting_id == meeting_id)
            .cloned()
            .collect())
    }

    async fn get_due(&self) -> Result<Vec<Reminder>> {
        let data = self.data.read().await;
        let now = chrono::Utc::now();

        Ok(data
            .values()
            .filter(|r| {
                r.status == ReminderStatus::Pending
                    && chrono::DateTime::parse_from_rfc3339(&r.scheduled_for)
                        .map(|dt| dt <= now)
                        .unwrap_or(false)
            })
            .cloned()
            .collect())
    }
}
