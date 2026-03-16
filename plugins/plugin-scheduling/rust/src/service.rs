//! Core scheduling service for multi-party coordination, availability
//! intersection, and calendar management.

use std::sync::Arc;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use log::{debug, info, warn};
use uuid::Uuid;

use crate::config::SchedulingServiceConfig;
use crate::error::{Result, SchedulingError};
use crate::ical::generate_ics;
use crate::storage::{AvailabilityStorage, MeetingStorage, ReminderStorage, SchedulingRequestStorage};
use crate::types::*;

// ============================================================================
// TIMEZONE HELPERS
// ============================================================================

fn parse_tz(tz_name: &str) -> Result<Tz> {
    tz_name
        .parse::<Tz>()
        .map_err(|_| SchedulingError::InvalidTimeZone {
            tz: tz_name.to_string(),
        })
}

fn get_day_of_week(dt: &DateTime<Utc>, tz: Tz) -> DayOfWeek {
    let local = dt.with_timezone(&tz);
    DayOfWeek::from_chrono_weekday(local.weekday())
}

fn get_minutes_of_day(dt: &DateTime<Utc>, tz: Tz) -> u32 {
    let local = dt.with_timezone(&tz);
    local.hour() * 60 + local.minute()
}

fn get_date_string(dt: &DateTime<Utc>, tz: Tz) -> String {
    let local = dt.with_timezone(&tz);
    local.format("%Y-%m-%d").to_string()
}

fn date_from_minutes(date_str: &str, minutes: u32, tz: Tz) -> Result<DateTime<Utc>> {
    let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
        .map_err(|e| SchedulingError::Parse(e.to_string()))?;
    let time = NaiveTime::from_hms_opt(minutes / 60, minutes % 60, 0)
        .ok_or_else(|| SchedulingError::Parse(format!("Invalid minutes: {}", minutes)))?;
    let naive = date.and_time(time);

    tz.from_local_datetime(&naive)
        .single()
        .map(|dt| dt.with_timezone(&Utc))
        .ok_or_else(|| SchedulingError::Parse("Ambiguous local time".to_string()))
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

// ============================================================================
// SCHEDULING SERVICE
// ============================================================================

pub struct SchedulingService {
    pub config: SchedulingServiceConfig,
    availability_storage: Arc<dyn AvailabilityStorage>,
    request_storage: Arc<dyn SchedulingRequestStorage>,
    meeting_storage: Arc<dyn MeetingStorage>,
    reminder_storage: Arc<dyn ReminderStorage>,
}

impl SchedulingService {
    pub fn new(
        config: SchedulingServiceConfig,
        availability_storage: Arc<dyn AvailabilityStorage>,
        request_storage: Arc<dyn SchedulingRequestStorage>,
        meeting_storage: Arc<dyn MeetingStorage>,
        reminder_storage: Arc<dyn ReminderStorage>,
    ) -> Self {
        Self {
            config,
            availability_storage,
            request_storage,
            meeting_storage,
            reminder_storage,
        }
    }

    // ========================================================================
    // AVAILABILITY
    // ========================================================================

    pub async fn save_availability(
        &self,
        entity_id: &str,
        availability: &Availability,
    ) -> Result<()> {
        self.availability_storage.save(entity_id, availability).await
    }

    pub async fn get_availability(&self, entity_id: &str) -> Result<Option<Availability>> {
        self.availability_storage.get(entity_id).await
    }

    pub fn is_available_at(&self, availability: &Availability, dt: &DateTime<Utc>) -> Result<bool> {
        let tz = parse_tz(&availability.time_zone)?;
        let day = get_day_of_week(dt, tz);
        let minutes = get_minutes_of_day(dt, tz);
        let date_str = get_date_string(dt, tz);

        // Check exceptions first
        if let Some(exc) = availability.exceptions.iter().find(|e| e.date == date_str) {
            if exc.unavailable {
                return Ok(false);
            }
            if let (Some(start), Some(end)) = (exc.start_minutes, exc.end_minutes) {
                return Ok(minutes >= start as u32 && minutes < end as u32);
            }
        }

        // Check weekly availability
        Ok(availability.weekly.iter().any(|w| {
            w.day == day && minutes >= w.start_minutes as u32 && minutes < w.end_minutes as u32
        }))
    }

    // ========================================================================
    // SCHEDULING REQUESTS
    // ========================================================================

    pub async fn create_scheduling_request(
        &self,
        room_id: &str,
        title: &str,
        participants: Vec<Participant>,
        constraints: SchedulingConstraints,
        urgency: SchedulingUrgency,
        description: Option<String>,
    ) -> Result<SchedulingRequest> {
        let request = SchedulingRequest {
            id: Uuid::new_v4().to_string(),
            room_id: room_id.to_string(),
            title: title.to_string(),
            description,
            participants,
            constraints,
            urgency,
            created_at: now_ms(),
            max_proposals: self.config.max_proposals,
        };

        self.request_storage.save(&request).await?;
        info!(
            "[SchedulingService] Created scheduling request {} for \"{}\"",
            request.id, title
        );
        Ok(request)
    }

    // ========================================================================
    // SLOT FINDING
    // ========================================================================

    pub async fn find_available_slots(
        &self,
        request: &SchedulingRequest,
    ) -> Result<SchedulingResult> {
        let participants = &request.participants;
        let constraints = &request.constraints;

        if participants.is_empty() {
            return Ok(SchedulingResult {
                success: false,
                proposed_slots: vec![],
                failure_reason: Some("No participants specified".to_string()),
                conflicting_participants: None,
            });
        }

        let availabilities: Vec<(&Participant, &Availability)> = participants
            .iter()
            .map(|p| (p, &p.availability))
            .collect();

        let reference_tz_name = &availabilities[0].1.time_zone;
        let reference_tz = parse_tz(reference_tz_name)?;

        let now = Utc::now();
        let mut candidate_slots: Vec<TimeSlot> = Vec::new();

        for day_offset in 0..constraints.max_days_out {
            let date = now + Duration::days(day_offset as i64);
            let day = get_day_of_week(&date, reference_tz);

            if let Some(ref pref_days) = constraints.preferred_days {
                if !pref_days.contains(&day) {
                    continue;
                }
            }

            let date_str = get_date_string(&date, reference_tz);

            let day_windows = self.find_day_intersection(
                &availabilities,
                day,
                &date_str,
                constraints.min_duration_minutes,
            );

            for window in &day_windows {
                let slot_duration = constraints.preferred_duration_minutes;
                let mut start_minutes = window.0;

                while start_minutes + slot_duration <= window.1 {
                    if day_offset == 0 {
                        let current_minutes = get_minutes_of_day(&now, reference_tz);
                        if start_minutes < current_minutes + 30 {
                            start_minutes += 30;
                            continue;
                        }
                    }

                    if let (Ok(start_date), Ok(end_date)) = (
                        date_from_minutes(&date_str, start_minutes, reference_tz),
                        date_from_minutes(&date_str, start_minutes + slot_duration, reference_tz),
                    ) {
                        candidate_slots.push(TimeSlot {
                            start: start_date.to_rfc3339(),
                            end: end_date.to_rfc3339(),
                            time_zone: reference_tz_name.clone(),
                        });
                    }

                    start_minutes += 30;
                }
            }
        }

        if candidate_slots.is_empty() {
            let conflicting = self.find_conflicting_participants(&availabilities);
            return Ok(SchedulingResult {
                success: false,
                proposed_slots: vec![],
                failure_reason: Some(
                    "No available time slots found within constraints".to_string(),
                ),
                conflicting_participants: Some(conflicting),
            });
        }

        let mut scored: Vec<ProposedSlot> = candidate_slots
            .iter()
            .map(|slot| self.score_slot(slot, request))
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        Ok(SchedulingResult {
            success: true,
            proposed_slots: scored.into_iter().take(3).collect(),
            failure_reason: None,
            conflicting_participants: None,
        })
    }

    fn find_day_intersection(
        &self,
        availabilities: &[(&Participant, &Availability)],
        day: DayOfWeek,
        date_str: &str,
        min_duration: u32,
    ) -> Vec<(u32, u32)> {
        let participant_windows: Vec<Vec<(u32, u32)>> = availabilities
            .iter()
            .map(|(_, avail)| {
                // Check exceptions
                if let Some(exc) = avail.exceptions.iter().find(|e| e.date == date_str) {
                    if exc.unavailable {
                        return vec![];
                    }
                    if let (Some(s), Some(e)) = (exc.start_minutes, exc.end_minutes) {
                        return vec![(s as u32, e as u32)];
                    }
                }

                avail
                    .weekly
                    .iter()
                    .filter(|w| w.day == day)
                    .map(|w| (w.start_minutes as u32, w.end_minutes as u32))
                    .collect()
            })
            .collect();

        if participant_windows.iter().any(|w| w.is_empty()) {
            return vec![];
        }

        let mut intersection = participant_windows[0].clone();

        for i in 1..participant_windows.len() {
            let mut new_intersection: Vec<(u32, u32)> = Vec::new();
            for wa in &intersection {
                for wb in &participant_windows[i] {
                    let start = wa.0.max(wb.0);
                    let end = wa.1.min(wb.1);
                    if end >= start + min_duration {
                        new_intersection.push((start, end));
                    }
                }
            }
            intersection = new_intersection;
            if intersection.is_empty() {
                break;
            }
        }

        intersection
    }

    fn find_conflicting_participants(
        &self,
        availabilities: &[(&Participant, &Availability)],
    ) -> Vec<String> {
        let mut conflicting = Vec::new();

        for i in 0..availabilities.len() {
            let mut has_overlap_with_all = true;
            for j in 0..availabilities.len() {
                if i == j {
                    continue;
                }
                if !self.has_any_overlap(availabilities[i].1, availabilities[j].1) {
                    has_overlap_with_all = false;
                    break;
                }
            }
            if !has_overlap_with_all {
                conflicting.push(availabilities[i].0.entity_id.clone());
            }
        }

        conflicting
    }

    fn has_any_overlap(&self, a: &Availability, b: &Availability) -> bool {
        for wa in &a.weekly {
            for wb in &b.weekly {
                if wa.day != wb.day {
                    continue;
                }
                let start = wa.start_minutes.max(wb.start_minutes);
                let end = wa.end_minutes.min(wb.end_minutes);
                if end > start && (end - start) >= 30 {
                    return true;
                }
            }
        }
        false
    }

    fn score_slot(&self, slot: &TimeSlot, request: &SchedulingRequest) -> ProposedSlot {
        let constraints = &request.constraints;
        let urgency = request.urgency;
        let mut score: f64 = 100.0;
        let mut reasons: Vec<String> = Vec::new();
        let mut concerns: Vec<String> = Vec::new();

        if let Ok(start_date) = DateTime::parse_from_rfc3339(&slot.start) {
            let start_utc = start_date.with_timezone(&Utc);

            if let Ok(tz) = parse_tz(&slot.time_zone) {
                let minutes = get_minutes_of_day(&start_utc, tz);
                let day = get_day_of_week(&start_utc, tz);

                // Time of day scoring
                let time_of_day = if minutes < 12 * 60 {
                    "morning"
                } else if minutes < 17 * 60 {
                    "afternoon"
                } else {
                    "evening"
                };

                if let Some(ref pref_times) = constraints.preferred_times {
                    if pref_times.iter().any(|t| t == time_of_day) {
                        score += 20.0;
                        reasons.push(format!("Preferred time ({})", time_of_day));
                    }
                }

                // Day of week scoring
                if let Some(ref pref_days) = constraints.preferred_days {
                    if pref_days.contains(&day) {
                        score += 15.0;
                        reasons.push(format!("Preferred day ({})", day.as_str()));
                    }
                }

                // Urgency scoring
                let days_from_now =
                    (start_utc.timestamp() - Utc::now().timestamp()) as f64 / 86400.0;

                match urgency {
                    SchedulingUrgency::Urgent => {
                        score -= days_from_now * 10.0;
                        if days_from_now < 2.0 {
                            reasons.push("Soon (urgent meeting)".to_string());
                        }
                    }
                    SchedulingUrgency::Soon => {
                        score -= days_from_now * 5.0;
                    }
                    _ => {}
                }

                // Penalize very early or very late
                if minutes < 9 * 60 {
                    score -= 15.0;
                    concerns.push("Early morning".to_string());
                } else if minutes > 18 * 60 {
                    score -= 10.0;
                    concerns.push("Evening time".to_string());
                }

                // Bonus for standard business hours
                if minutes >= 10 * 60 && minutes <= 16 * 60 {
                    score += 10.0;
                    reasons.push("Standard business hours".to_string());
                }
            }
        }

        ProposedSlot {
            slot: slot.clone(),
            score: score.max(0.0),
            reasons,
            concerns,
        }
    }

    // ========================================================================
    // MEETING CRUD
    // ========================================================================

    pub async fn create_meeting(
        &self,
        request: &SchedulingRequest,
        slot: TimeSlot,
        location: MeetingLocation,
    ) -> Result<Meeting> {
        let participants: Vec<MeetingParticipant> = request
            .participants
            .iter()
            .enumerate()
            .map(|(i, p)| MeetingParticipant {
                entity_id: p.entity_id.clone(),
                name: p.name.clone(),
                email: p.email.clone(),
                phone: p.phone.clone(),
                role: if i == 0 {
                    ParticipantRole::Organizer
                } else {
                    ParticipantRole::Required
                },
                confirmed: false,
                confirmed_at: None,
                decline_reason: None,
            })
            .collect();

        let meeting = Meeting {
            id: Uuid::new_v4().to_string(),
            request_id: request.id.clone(),
            room_id: request.room_id.clone(),
            title: request.title.clone(),
            description: request.description.clone(),
            slot,
            location,
            participants,
            status: MeetingStatus::Proposed,
            reschedule_count: 0,
            cancellation_reason: None,
            created_at: now_ms(),
            updated_at: now_ms(),
            notes: None,
            meta: None,
        };

        self.meeting_storage.save(&meeting).await?;
        info!(
            "[SchedulingService] Created meeting {} for \"{}\"",
            meeting.id, meeting.title
        );

        if self.config.auto_schedule_reminders {
            let _ = self.schedule_reminders(&meeting).await;
        }

        Ok(meeting)
    }

    pub async fn get_meeting(&self, meeting_id: &str) -> Result<Option<Meeting>> {
        self.meeting_storage.get(meeting_id).await
    }

    pub async fn get_meetings_for_room(&self, room_id: &str) -> Result<Vec<Meeting>> {
        self.meeting_storage.get_by_room(room_id).await
    }

    pub async fn get_upcoming_meetings(&self, entity_id: &str) -> Result<Vec<Meeting>> {
        self.meeting_storage
            .get_upcoming_for_participant(entity_id)
            .await
    }

    pub async fn confirm_participant(
        &self,
        meeting_id: &str,
        entity_id: &str,
    ) -> Result<Meeting> {
        let mut meeting = self
            .meeting_storage
            .get(meeting_id)
            .await?
            .ok_or_else(|| SchedulingError::MeetingNotFound {
                meeting_id: meeting_id.to_string(),
            })?;

        let participant = meeting
            .participants
            .iter_mut()
            .find(|p| p.entity_id == entity_id)
            .ok_or_else(|| SchedulingError::ParticipantNotFound {
                entity_id: entity_id.to_string(),
                meeting_id: meeting_id.to_string(),
            })?;

        participant.confirmed = true;
        participant.confirmed_at = Some(now_ms());
        meeting.updated_at = now_ms();

        let all_confirmed = meeting
            .participants
            .iter()
            .filter(|p| p.role != ParticipantRole::Optional)
            .all(|p| p.confirmed);

        if all_confirmed && meeting.status == MeetingStatus::Proposed {
            meeting.status = MeetingStatus::Confirmed;
            info!(
                "[SchedulingService] Meeting {} confirmed by all participants",
                meeting_id
            );
            if self.config.auto_send_calendar_invites {
                let _ = self.send_calendar_invites(&meeting).await;
                meeting.status = MeetingStatus::Scheduled;
            }
        }

        self.meeting_storage.save(&meeting).await?;
        Ok(meeting)
    }

    pub async fn decline_participant(
        &self,
        meeting_id: &str,
        entity_id: &str,
        reason: Option<&str>,
    ) -> Result<Meeting> {
        let mut meeting = self
            .meeting_storage
            .get(meeting_id)
            .await?
            .ok_or_else(|| SchedulingError::MeetingNotFound {
                meeting_id: meeting_id.to_string(),
            })?;

        let participant = meeting
            .participants
            .iter_mut()
            .find(|p| p.entity_id == entity_id)
            .ok_or_else(|| SchedulingError::ParticipantNotFound {
                entity_id: entity_id.to_string(),
                meeting_id: meeting_id.to_string(),
            })?;

        let is_optional = participant.role == ParticipantRole::Optional;
        let name = participant.name.clone();

        participant.confirmed = false;
        participant.decline_reason = reason.map(|s| s.to_string());
        meeting.updated_at = now_ms();

        if !is_optional {
            meeting.status = MeetingStatus::Rescheduling;
            meeting.cancellation_reason = Some(format!(
                "{} declined: {}",
                name,
                reason.unwrap_or("No reason given")
            ));
            info!(
                "[SchedulingService] Meeting {} needs rescheduling",
                meeting_id
            );
        }

        self.meeting_storage.save(&meeting).await?;
        Ok(meeting)
    }

    pub async fn cancel_meeting(
        &self,
        meeting_id: &str,
        reason: Option<&str>,
    ) -> Result<Meeting> {
        let mut meeting = self
            .meeting_storage
            .get(meeting_id)
            .await?
            .ok_or_else(|| SchedulingError::MeetingNotFound {
                meeting_id: meeting_id.to_string(),
            })?;

        meeting.status = MeetingStatus::Cancelled;
        meeting.cancellation_reason = reason.map(|s| s.to_string());
        meeting.updated_at = now_ms();

        let _ = self.cancel_reminders(meeting_id).await;

        self.meeting_storage.save(&meeting).await?;
        info!("[SchedulingService] Meeting {} cancelled", meeting_id);
        Ok(meeting)
    }

    pub async fn update_meeting_status(
        &self,
        meeting_id: &str,
        status: MeetingStatus,
    ) -> Result<Meeting> {
        let mut meeting = self
            .meeting_storage
            .get(meeting_id)
            .await?
            .ok_or_else(|| SchedulingError::MeetingNotFound {
                meeting_id: meeting_id.to_string(),
            })?;

        meeting.status = status;
        meeting.updated_at = now_ms();

        self.meeting_storage.save(&meeting).await?;
        Ok(meeting)
    }

    pub async fn reschedule_meeting(
        &self,
        meeting_id: &str,
        new_slot: TimeSlot,
        reason: Option<&str>,
    ) -> Result<Meeting> {
        let mut meeting = self
            .meeting_storage
            .get(meeting_id)
            .await?
            .ok_or_else(|| SchedulingError::MeetingNotFound {
                meeting_id: meeting_id.to_string(),
            })?;

        let _ = self.cancel_reminders(meeting_id).await;

        meeting.slot = new_slot;
        meeting.status = MeetingStatus::Proposed;
        meeting.reschedule_count += 1;
        meeting.cancellation_reason = reason.map(|s| s.to_string());
        meeting.updated_at = now_ms();

        for p in &mut meeting.participants {
            p.confirmed = false;
            p.confirmed_at = None;
        }

        self.meeting_storage.save(&meeting).await?;

        if self.config.auto_schedule_reminders {
            let _ = self.schedule_reminders(&meeting).await;
        }

        info!(
            "[SchedulingService] Meeting {} rescheduled (count: {})",
            meeting_id, meeting.reschedule_count
        );
        Ok(meeting)
    }

    // ========================================================================
    // CALENDAR INVITES
    // ========================================================================

    pub fn generate_calendar_invite(
        &self,
        meeting: &Meeting,
        recipient_email: &str,
        recipient_name: &str,
    ) -> CalendarInvite {
        let organizer = meeting
            .participants
            .iter()
            .find(|p| p.role == ParticipantRole::Organizer);

        let location_str = match meeting.location.location_type {
            LocationType::InPerson => {
                let name = meeting.location.name.as_deref().unwrap_or("");
                let addr = meeting.location.address.as_deref().unwrap_or("");
                Some(format!("{}, {}", name, addr))
            }
            _ => meeting.location.video_url.clone(),
        };

        let event = CalendarEvent {
            uid: meeting.id.clone(),
            title: meeting.title.clone(),
            description: meeting.description.clone(),
            start: meeting.slot.start.clone(),
            end: meeting.slot.end.clone(),
            time_zone: meeting.slot.time_zone.clone(),
            location: location_str,
            organizer: organizer.and_then(|o| {
                o.email.as_ref().map(|email| CalendarEventOrganizer {
                    name: o.name.clone(),
                    email: email.clone(),
                })
            }),
            attendees: Some(
                meeting
                    .participants
                    .iter()
                    .filter_map(|p| {
                        p.email.as_ref().map(|email| CalendarEventAttendee {
                            name: p.name.clone(),
                            email: email.clone(),
                            role: p.role,
                        })
                    })
                    .collect(),
            ),
            url: meeting.location.video_url.clone(),
            reminder_minutes: Some(self.config.default_reminder_minutes.clone()),
        };

        let ics = generate_ics(&event);

        CalendarInvite {
            ics,
            event,
            recipient_email: recipient_email.to_string(),
            recipient_name: recipient_name.to_string(),
        }
    }

    pub async fn send_calendar_invites(&self, meeting: &Meeting) -> Result<Vec<CalendarInvite>> {
        let mut invites = Vec::new();

        for participant in &meeting.participants {
            if let Some(ref email) = participant.email {
                let invite =
                    self.generate_calendar_invite(meeting, email, &participant.name);
                invites.push(invite);
                info!(
                    "[SchedulingService] Generated calendar invite for {} (meeting {})",
                    email, meeting.id
                );
            } else {
                warn!(
                    "[SchedulingService] Participant {} has no email - skipping invite",
                    participant.name
                );
            }
        }

        Ok(invites)
    }

    // ========================================================================
    // REMINDERS
    // ========================================================================

    pub async fn schedule_reminders(&self, meeting: &Meeting) -> Result<Vec<Reminder>> {
        let mut reminders = Vec::new();

        if let Ok(meeting_dt) = DateTime::parse_from_rfc3339(&meeting.slot.start) {
            let meeting_time_ms = meeting_dt.timestamp_millis();

            for minutes_before in &self.config.default_reminder_minutes {
                let scheduled_ms =
                    meeting_time_ms - (*minutes_before as i64) * 60 * 1000;
                if scheduled_ms < now_ms() {
                    continue;
                }

                let scheduled_dt =
                    DateTime::from_timestamp_millis(scheduled_ms).unwrap_or(Utc::now());
                let scheduled_for = scheduled_dt.to_rfc3339();

                for participant in &meeting.participants {
                    let reminder_type = if participant.phone.is_some() {
                        ReminderType::Sms
                    } else if participant.email.is_some() {
                        ReminderType::Email
                    } else {
                        ReminderType::Push
                    };

                    let time_label = if *minutes_before >= 1440 {
                        format!("{} day(s)", minutes_before / 1440)
                    } else if *minutes_before >= 60 {
                        format!("{} hour(s)", minutes_before / 60)
                    } else {
                        format!("{} minutes", minutes_before)
                    };

                    let reminder = Reminder {
                        id: Uuid::new_v4().to_string(),
                        meeting_id: meeting.id.clone(),
                        participant_id: participant.entity_id.clone(),
                        scheduled_for: scheduled_for.clone(),
                        reminder_type,
                        message: format!(
                            "Reminder: \"{}\" is in {}",
                            meeting.title, time_label
                        ),
                        status: ReminderStatus::Pending,
                        sent_at: None,
                        error: None,
                        created_at: now_ms(),
                    };

                    self.reminder_storage.save(&reminder).await?;
                    reminders.push(reminder);
                }
            }
        }

        debug!(
            "[SchedulingService] Scheduled {} reminders for meeting {}",
            reminders.len(),
            meeting.id
        );
        Ok(reminders)
    }

    pub async fn get_due_reminders(&self) -> Result<Vec<Reminder>> {
        self.reminder_storage.get_due().await
    }

    pub async fn mark_reminder_sent(&self, reminder_id: &str) -> Result<()> {
        if let Some(mut reminder) = self.reminder_storage.get(reminder_id).await? {
            reminder.status = ReminderStatus::Sent;
            reminder.sent_at = Some(now_ms());
            self.reminder_storage.save(&reminder).await?;
        }
        Ok(())
    }

    pub async fn cancel_reminders(&self, meeting_id: &str) -> Result<()> {
        let reminders = self.reminder_storage.get_by_meeting(meeting_id).await?;
        for mut reminder in reminders {
            if reminder.status == ReminderStatus::Pending {
                reminder.status = ReminderStatus::Cancelled;
                self.reminder_storage.save(&reminder).await?;
            }
        }
        Ok(())
    }

    // ========================================================================
    // FORMATTING
    // ========================================================================

    pub fn format_slot(&self, slot: &TimeSlot) -> String {
        if let Ok(start) = DateTime::parse_from_rfc3339(&slot.start) {
            if let Ok(end) = DateTime::parse_from_rfc3339(&slot.end) {
                if let Ok(tz) = parse_tz(&slot.time_zone) {
                    let start_local = start.with_timezone(&tz);
                    let end_local = end.with_timezone(&tz);

                    let date_str = start_local.format("%a, %b %-d");
                    let start_time = start_local.format("%-I:%M %p");
                    let end_time = end_local.format("%-I:%M %p");

                    return format!("{}, {} - {}", date_str, start_time, end_time);
                }
            }
        }
        format!("{} - {}", slot.start, slot.end)
    }
}
