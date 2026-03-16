//! Comprehensive integration tests for the scheduling plugin.

use std::sync::Arc;

use elizaos_plugin_scheduling::actions::confirm_meeting::ConfirmMeetingAction;
use elizaos_plugin_scheduling::actions::schedule_meeting::{
    format_proposed_slots, parse_meeting_request, ScheduleMeetingAction,
};
use elizaos_plugin_scheduling::actions::set_availability::{
    format_time, parse_availability_text, parse_days, parse_time_to_minutes,
    SetAvailabilityAction,
};
use elizaos_plugin_scheduling::config::SchedulingServiceConfig;
use elizaos_plugin_scheduling::error::SchedulingError;
use elizaos_plugin_scheduling::ical::{
    escape_ics, fold_line, format_ics_date, generate_ics, parse_ics, parse_ics_date, unescape_ics,
};
use elizaos_plugin_scheduling::providers::scheduling_context::SchedulingContextProvider;
use elizaos_plugin_scheduling::service::SchedulingService;
use elizaos_plugin_scheduling::storage::*;
use elizaos_plugin_scheduling::types::*;

// ============================================================================
// HELPERS
// ============================================================================

fn create_test_service() -> SchedulingService {
    let config = SchedulingServiceConfig {
        auto_send_calendar_invites: false,
        auto_schedule_reminders: false,
        ..Default::default()
    };
    SchedulingService::new(
        config,
        Arc::new(InMemoryAvailabilityStorage::new()),
        Arc::new(InMemorySchedulingRequestStorage::new()),
        Arc::new(InMemoryMeetingStorage::new()),
        Arc::new(InMemoryReminderStorage::new()),
    )
}

fn sample_availability() -> Availability {
    Availability {
        time_zone: "America/New_York".to_string(),
        weekly: vec![
            AvailabilityWindow { day: DayOfWeek::Mon, start_minutes: 540, end_minutes: 1020 },
            AvailabilityWindow { day: DayOfWeek::Tue, start_minutes: 540, end_minutes: 1020 },
            AvailabilityWindow { day: DayOfWeek::Wed, start_minutes: 540, end_minutes: 1020 },
            AvailabilityWindow { day: DayOfWeek::Thu, start_minutes: 540, end_minutes: 1020 },
            AvailabilityWindow { day: DayOfWeek::Fri, start_minutes: 540, end_minutes: 1020 },
        ],
        exceptions: vec![],
    }
}

fn sample_participants() -> (Participant, Participant) {
    let alice = Participant {
        entity_id: "alice-id".to_string(),
        name: "Alice".to_string(),
        email: Some("alice@example.com".to_string()),
        phone: None,
        availability: sample_availability(),
        priority: 1,
    };
    let bob = Participant {
        entity_id: "bob-id".to_string(),
        name: "Bob".to_string(),
        email: Some("bob@example.com".to_string()),
        phone: None,
        availability: Availability {
            time_zone: "America/New_York".to_string(),
            weekly: vec![
                AvailabilityWindow { day: DayOfWeek::Mon, start_minutes: 600, end_minutes: 960 },
                AvailabilityWindow { day: DayOfWeek::Wed, start_minutes: 600, end_minutes: 960 },
                AvailabilityWindow { day: DayOfWeek::Fri, start_minutes: 600, end_minutes: 960 },
            ],
            exceptions: vec![],
        },
        priority: 1,
    };
    (alice, bob)
}

// ============================================================================
// TYPE TESTS
// ============================================================================

#[test]
fn test_day_of_week_values() {
    assert_eq!(DayOfWeek::Mon.as_str(), "mon");
    assert_eq!(DayOfWeek::Fri.as_str(), "fri");
    assert_eq!(DayOfWeek::Sun.as_str(), "sun");
}

#[test]
fn test_day_of_week_display_names() {
    assert_eq!(DayOfWeek::Mon.display_name(), "Monday");
    assert_eq!(DayOfWeek::Sun.display_name(), "Sunday");
}

#[test]
fn test_day_of_week_collections() {
    assert_eq!(DayOfWeek::weekdays().len(), 5);
    assert_eq!(DayOfWeek::weekends().len(), 2);
    assert_eq!(DayOfWeek::all().len(), 7);
}

#[test]
fn test_scheduling_constraints_default() {
    let c = SchedulingConstraints::default();
    assert_eq!(c.min_duration_minutes, 30);
    assert_eq!(c.preferred_duration_minutes, 60);
    assert_eq!(c.max_days_out, 7);
}

#[test]
fn test_meeting_status_serde() {
    let json = serde_json::to_string(&MeetingStatus::Proposed).unwrap();
    assert_eq!(json, "\"proposed\"");
    let parsed: MeetingStatus = serde_json::from_str("\"cancelled\"").unwrap();
    assert_eq!(parsed, MeetingStatus::Cancelled);
}

#[test]
fn test_types_serde_roundtrip() {
    let avail = sample_availability();
    let json = serde_json::to_string(&avail).unwrap();
    let parsed: Availability = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.time_zone, "America/New_York");
    assert_eq!(parsed.weekly.len(), 5);
}

#[test]
fn test_config_default() {
    let config = SchedulingServiceConfig::default();
    assert_eq!(config.default_reminder_minutes, vec![1440, 120]);
    assert_eq!(config.max_proposals, 3);
    assert_eq!(config.default_max_days_out, 7);
    assert_eq!(config.min_meeting_duration, 30);
    assert_eq!(config.default_meeting_duration, 60);
    assert!(config.auto_send_calendar_invites);
    assert!(config.auto_schedule_reminders);
}

// ============================================================================
// ICS TESTS
// ============================================================================

#[test]
fn test_escape_ics() {
    assert_eq!(escape_ics("a\\b"), "a\\\\b");
    assert_eq!(escape_ics("a;b"), "a\\;b");
    assert_eq!(escape_ics("a,b"), "a\\,b");
    assert_eq!(escape_ics("a\nb"), "a\\nb");
}

#[test]
fn test_unescape_ics_roundtrip() {
    let original = "Hello\\, World;Test\nNewline";
    assert_eq!(unescape_ics(&escape_ics(original)), original);
}

#[test]
fn test_format_ics_date() {
    assert_eq!(format_ics_date("2025-01-20T15:00:00Z"), "20250120T150000Z");
    assert_eq!(format_ics_date("2025-01-20T15:00:00.000Z"), "20250120T150000Z");
}

#[test]
fn test_parse_ics_date() {
    assert_eq!(parse_ics_date("20250120T150000Z"), "2025-01-20T15:00:00Z");
    assert_eq!(parse_ics_date("20250120T150000"), "2025-01-20T15:00:00Z");
    assert_eq!(parse_ics_date("not-a-date"), "not-a-date");
}

#[test]
fn test_fold_line_short() {
    assert_eq!(fold_line("SHORT"), "SHORT");
}

#[test]
fn test_fold_line_long() {
    let line = "A".repeat(100);
    let folded = fold_line(&line);
    assert!(folded.contains("\r\n"));
    let parts: Vec<&str> = folded.split("\r\n").collect();
    assert_eq!(parts[0].len(), 75);
    assert!(parts[1].starts_with(' '));
}

#[test]
fn test_fold_line_exact_75() {
    let line = "B".repeat(75);
    assert_eq!(fold_line(&line), line);
}

#[test]
fn test_generate_ics_basic() {
    let event = CalendarEvent {
        uid: "test-uid-123".to_string(),
        title: "Team Standup".to_string(),
        description: None,
        start: "2025-01-20T15:00:00Z".to_string(),
        end: "2025-01-20T15:30:00Z".to_string(),
        time_zone: "UTC".to_string(),
        location: None,
        organizer: None,
        attendees: None,
        url: None,
        reminder_minutes: None,
    };
    let ics = generate_ics(&event);

    assert!(ics.contains("BEGIN:VCALENDAR"));
    assert!(ics.contains("END:VCALENDAR"));
    assert!(ics.contains("BEGIN:VEVENT"));
    assert!(ics.contains("END:VEVENT"));
    assert!(ics.contains("UID:test-uid-123"));
    assert!(ics.contains("SUMMARY:Team Standup"));
    assert!(ics.contains("DTSTART:20250120T150000Z"));
    assert!(ics.contains("DTEND:20250120T153000Z"));
    assert!(ics.contains("VERSION:2.0"));
}

#[test]
fn test_generate_ics_with_optional_fields() {
    let event = CalendarEvent {
        uid: "test-uid".to_string(),
        title: "Review".to_string(),
        description: Some("Quarterly review".to_string()),
        start: "2025-01-20T15:00:00Z".to_string(),
        end: "2025-01-20T16:00:00Z".to_string(),
        time_zone: "UTC".to_string(),
        location: Some("Conference Room A".to_string()),
        organizer: Some(CalendarEventOrganizer {
            name: "Alice".to_string(),
            email: "alice@example.com".to_string(),
        }),
        attendees: Some(vec![
            CalendarEventAttendee {
                name: "Bob".to_string(),
                email: "bob@example.com".to_string(),
                role: ParticipantRole::Required,
            },
            CalendarEventAttendee {
                name: "Carol".to_string(),
                email: "carol@example.com".to_string(),
                role: ParticipantRole::Optional,
            },
        ]),
        url: Some("https://meet.example.com/abc".to_string()),
        reminder_minutes: Some(vec![1440, 120]),
    };
    let ics = generate_ics(&event);

    assert!(ics.contains("DESCRIPTION:Quarterly review"));
    assert!(ics.contains("LOCATION:Conference Room A"));
    assert!(ics.contains("ORGANIZER;CN=Alice:mailto:alice@example.com"));
    assert!(ics.contains("ROLE=REQ-PARTICIPANT"));
    assert!(ics.contains("ROLE=OPT-PARTICIPANT"));
    assert!(ics.contains("URL:https://meet.example.com/abc"));
    assert!(ics.contains("BEGIN:VALARM"));
    assert!(ics.contains("TRIGGER:-PT1440M"));
    assert!(ics.contains("TRIGGER:-PT120M"));
}

#[test]
fn test_parse_ics_roundtrip() {
    let event = CalendarEvent {
        uid: "roundtrip-uid".to_string(),
        title: "Roundtrip Test".to_string(),
        description: Some("Testing roundtrip".to_string()),
        start: "2025-01-20T15:00:00Z".to_string(),
        end: "2025-01-20T16:00:00Z".to_string(),
        time_zone: "UTC".to_string(),
        location: Some("Conference Room B".to_string()),
        organizer: None,
        attendees: None,
        url: None,
        reminder_minutes: None,
    };
    let ics = generate_ics(&event);
    let parsed = parse_ics(&ics);

    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].uid, "roundtrip-uid");
    assert_eq!(parsed[0].title, "Roundtrip Test");
    assert_eq!(parsed[0].description.as_deref(), Some("Testing roundtrip"));
    assert!(parsed[0].start.contains("2025-01-20"));
    assert_eq!(parsed[0].location.as_deref(), Some("Conference Room B"));
}

#[test]
fn test_parse_ics_empty() {
    assert!(parse_ics("").is_empty());
    assert!(parse_ics("BEGIN:VCALENDAR\r\nEND:VCALENDAR").is_empty());
}

// ============================================================================
// ACTION VALIDATION TESTS
// ============================================================================

#[test]
fn test_schedule_meeting_validate() {
    assert!(ScheduleMeetingAction::validate("Can you schedule a meeting?"));
    assert!(ScheduleMeetingAction::validate("I need to book a room"));
    assert!(ScheduleMeetingAction::validate("Let's arrange a call"));
    assert!(ScheduleMeetingAction::validate("Can we meet tomorrow?"));
    assert!(!ScheduleMeetingAction::validate("Nice to meet you!"));
    assert!(!ScheduleMeetingAction::validate("What's the weather like?"));
}

#[test]
fn test_schedule_meeting_metadata() {
    assert_eq!(ScheduleMeetingAction::NAME, "SCHEDULE_MEETING");
    assert!(ScheduleMeetingAction::SIMILES.contains(&"BOOK_MEETING"));
}

#[test]
fn test_parse_meeting_request_title() {
    let result = parse_meeting_request("Schedule a meeting about Q4 planning");
    assert_eq!(result.title.as_deref(), Some("Q4 planning"));
}

#[test]
fn test_parse_meeting_request_duration_minutes() {
    let result = parse_meeting_request("Book a 45 minute call");
    assert_eq!(result.duration, Some(45));
}

#[test]
fn test_parse_meeting_request_duration_hours() {
    let result = parse_meeting_request("Set up a 2 hour meeting");
    assert_eq!(result.duration, Some(120));
}

#[test]
fn test_parse_meeting_request_urgency() {
    assert_eq!(parse_meeting_request("I need a meeting asap").urgency, "urgent");
    assert_eq!(parse_meeting_request("Let's meet this week").urgency, "soon");
    assert_eq!(parse_meeting_request("Can we meet sometime?").urgency, "flexible");
}

#[test]
fn test_format_proposed_slots_empty() {
    assert!(format_proposed_slots(&[]).contains("couldn't find"));
}

#[test]
fn test_format_proposed_slots_with_data() {
    let slots = vec![ProposedSlot {
        slot: TimeSlot {
            start: "2025-01-20T15:00:00Z".to_string(),
            end: "2025-01-20T15:30:00Z".to_string(),
            time_zone: "UTC".to_string(),
        },
        score: 100.0,
        reasons: vec!["Standard business hours".to_string()],
        concerns: vec![],
    }];
    let result = format_proposed_slots(&slots);
    assert!(result.contains("1."));
    assert!(result.contains("Standard business hours"));
    assert!(result.contains("Which option"));
}

#[test]
fn test_confirm_meeting_validate() {
    assert!(ConfirmMeetingAction::validate("I confirm the meeting"));
    assert!(ConfirmMeetingAction::validate("I need to decline the meeting"));
    assert!(ConfirmMeetingAction::validate("RSVP to the event"));
    assert!(ConfirmMeetingAction::validate("Yes, I'll be there"));
    assert!(ConfirmMeetingAction::validate("Sorry, I can't make it"));
    assert!(!ConfirmMeetingAction::validate("What time is it?"));
}

#[test]
fn test_confirm_meeting_is_confirming() {
    assert!(ConfirmMeetingAction::is_confirming("Yes, I confirm"));
    assert!(ConfirmMeetingAction::is_confirming("I accept the meeting"));
    assert!(ConfirmMeetingAction::is_confirming("I'll be there"));
    assert!(!ConfirmMeetingAction::is_confirming("I can't make it"));
}

#[test]
fn test_set_availability_validate() {
    assert!(SetAvailabilityAction::validate("I'm available weekdays"));
    assert!(SetAvailabilityAction::validate("I'm free on Monday"));
    assert!(SetAvailabilityAction::validate("mornings work best for me"));
    assert!(!SetAvailabilityAction::validate("What is Rust?"));
}

// ============================================================================
// AVAILABILITY PARSING TESTS
// ============================================================================

#[test]
fn test_parse_time_to_minutes() {
    assert_eq!(parse_time_to_minutes("14:30"), Some(870));
    assert_eq!(parse_time_to_minutes("9am"), Some(540));
    assert_eq!(parse_time_to_minutes("5pm"), Some(1020));
    assert_eq!(parse_time_to_minutes("10:30am"), Some(630));
    assert_eq!(parse_time_to_minutes("12pm"), Some(720));
    assert_eq!(parse_time_to_minutes("12am"), Some(0));
    assert_eq!(parse_time_to_minutes("not-a-time"), None);
}

#[test]
fn test_parse_days() {
    assert_eq!(parse_days("weekdays").len(), 5);
    assert_eq!(parse_days("weekends").len(), 2);
    assert_eq!(parse_days("everyday").len(), 7);
    assert_eq!(parse_days("monday"), vec![DayOfWeek::Mon]);
    assert_eq!(parse_days("fri"), vec![DayOfWeek::Fri]);
    assert!(parse_days("notaday").is_empty());
}

#[test]
fn test_parse_availability_weekdays_time_range() {
    let result = parse_availability_text("weekdays 9am to 5pm").unwrap();
    assert_eq!(result.windows.len(), 5);
    for w in &result.windows {
        assert_eq!(w.start_minutes, 540);
        assert_eq!(w.end_minutes, 1020);
    }
}

#[test]
fn test_parse_availability_single_day_preset() {
    let result = parse_availability_text("Monday mornings").unwrap();
    assert_eq!(result.windows.len(), 1);
    assert_eq!(result.windows[0].day, DayOfWeek::Mon);
    assert_eq!(result.windows[0].start_minutes, 540);
    assert_eq!(result.windows[0].end_minutes, 720);
}

#[test]
fn test_parse_availability_timezone() {
    let result = parse_availability_text("weekdays 9am to 5pm timezone America/Chicago").unwrap();
    assert_eq!(result.time_zone.as_deref(), Some("America/Chicago"));
}

#[test]
fn test_parse_availability_fallback() {
    let result = parse_availability_text("I'm free mornings").unwrap();
    assert_eq!(result.windows.len(), 5); // Weekdays assumed
}

#[test]
fn test_parse_availability_unparseable() {
    assert!(parse_availability_text("Let's talk later").is_none());
}

#[test]
fn test_format_time() {
    assert_eq!(format_time(540), "9am");
    assert_eq!(format_time(1020), "5pm");
    assert_eq!(format_time(630), "10:30am");
    assert_eq!(format_time(720), "12pm");
    assert_eq!(format_time(0), "12am");
}

// ============================================================================
// SERVICE TESTS
// ============================================================================

#[tokio::test]
async fn test_availability_save_and_get() {
    let service = create_test_service();
    let avail = sample_availability();

    service.save_availability("alice-id", &avail).await.unwrap();
    let result = service.get_availability("alice-id").await.unwrap();

    assert!(result.is_some());
    let result = result.unwrap();
    assert_eq!(result.time_zone, "America/New_York");
    assert_eq!(result.weekly.len(), 5);
}

#[tokio::test]
async fn test_availability_get_nonexistent() {
    let service = create_test_service();
    let result = service.get_availability("nonexistent-id").await.unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn test_is_available_at_weekday_business_hours() {
    let service = create_test_service();
    let avail = Availability {
        time_zone: "UTC".to_string(),
        weekly: vec![
            AvailabilityWindow { day: DayOfWeek::Mon, start_minutes: 540, end_minutes: 1020 },
        ],
        exceptions: vec![],
    };
    // 2025-01-20 is a Monday
    let dt = chrono::DateTime::parse_from_rfc3339("2025-01-20T10:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert!(service.is_available_at(&avail, &dt).unwrap());
}

#[tokio::test]
async fn test_is_available_exception_unavailable() {
    let service = create_test_service();
    let avail = Availability {
        time_zone: "UTC".to_string(),
        weekly: vec![
            AvailabilityWindow { day: DayOfWeek::Mon, start_minutes: 540, end_minutes: 1020 },
        ],
        exceptions: vec![AvailabilityException {
            date: "2025-01-20".to_string(),
            unavailable: true,
            start_minutes: None,
            end_minutes: None,
            reason: None,
        }],
    };
    let dt = chrono::DateTime::parse_from_rfc3339("2025-01-20T10:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert!(!service.is_available_at(&avail, &dt).unwrap());
}

#[tokio::test]
async fn test_is_available_exception_override() {
    let service = create_test_service();
    let avail = Availability {
        time_zone: "UTC".to_string(),
        weekly: vec![
            AvailabilityWindow { day: DayOfWeek::Mon, start_minutes: 540, end_minutes: 1020 },
        ],
        exceptions: vec![AvailabilityException {
            date: "2025-01-20".to_string(),
            unavailable: false,
            start_minutes: Some(600),
            end_minutes: Some(720),
            reason: None,
        }],
    };
    // 10:00 UTC = 600 min -> in exception window
    let dt = chrono::DateTime::parse_from_rfc3339("2025-01-20T10:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert!(service.is_available_at(&avail, &dt).unwrap());

    // 13:00 UTC = 780 min -> outside exception window
    let dt2 = chrono::DateTime::parse_from_rfc3339("2025-01-20T13:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert!(!service.is_available_at(&avail, &dt2).unwrap());
}

#[tokio::test]
async fn test_find_slots_single_participant() {
    let service = create_test_service();
    let (alice, _) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Solo Meeting".to_string(),
        description: None,
        participants: vec![alice],
        constraints: SchedulingConstraints {
            min_duration_minutes: 30,
            preferred_duration_minutes: 30,
            max_days_out: 7,
            ..Default::default()
        },
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let result = service.find_available_slots(&request).await.unwrap();
    assert!(result.success);
    assert!(!result.proposed_slots.is_empty());
    assert!(result.proposed_slots.len() <= 3);
}

#[tokio::test]
async fn test_find_slots_no_participants() {
    let service = create_test_service();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Empty".to_string(),
        description: None,
        participants: vec![],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let result = service.find_available_slots(&request).await.unwrap();
    assert!(!result.success);
    assert_eq!(result.failure_reason.as_deref(), Some("No participants specified"));
}

#[tokio::test]
async fn test_find_slots_no_overlap() {
    let service = create_test_service();

    let alice = Participant {
        entity_id: "alice".to_string(),
        name: "Alice".to_string(),
        email: None,
        phone: None,
        availability: Availability {
            time_zone: "UTC".to_string(),
            weekly: vec![AvailabilityWindow {
                day: DayOfWeek::Mon,
                start_minutes: 540,
                end_minutes: 600,
            }],
            exceptions: vec![],
        },
        priority: 1,
    };
    let bob = Participant {
        entity_id: "bob".to_string(),
        name: "Bob".to_string(),
        email: None,
        phone: None,
        availability: Availability {
            time_zone: "UTC".to_string(),
            weekly: vec![AvailabilityWindow {
                day: DayOfWeek::Tue,
                start_minutes: 540,
                end_minutes: 600,
            }],
            exceptions: vec![],
        },
        priority: 1,
    };

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "No Overlap".to_string(),
        description: None,
        participants: vec![alice, bob],
        constraints: SchedulingConstraints {
            min_duration_minutes: 30,
            max_days_out: 7,
            ..Default::default()
        },
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let result = service.find_available_slots(&request).await.unwrap();
    assert!(!result.success);
    assert!(result.conflicting_participants.is_some());
}

// ============================================================================
// MEETING CRUD TESTS
// ============================================================================

#[tokio::test]
async fn test_create_and_get_meeting() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Test Meeting".to_string(),
        description: None,
        participants: vec![alice, bob],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None,
        address: None,
        city: None,
        place_id: None,
        video_url: Some("https://meet.example.com".to_string()),
        phone_number: None,
        notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();
    assert!(!meeting.id.is_empty());
    assert_eq!(meeting.title, "Test Meeting");
    assert_eq!(meeting.status, MeetingStatus::Proposed);
    assert_eq!(meeting.participants.len(), 2);
    assert_eq!(meeting.participants[0].role, ParticipantRole::Organizer);
    assert_eq!(meeting.participants[1].role, ParticipantRole::Required);

    let retrieved = service.get_meeting(&meeting.id).await.unwrap();
    assert!(retrieved.is_some());
    assert_eq!(retrieved.unwrap().id, meeting.id);
}

#[tokio::test]
async fn test_confirm_participant() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Test".to_string(),
        description: None,
        participants: vec![alice.clone(), bob],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None, address: None, city: None, place_id: None,
        video_url: None, phone_number: None, notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();
    let updated = service
        .confirm_participant(&meeting.id, &alice.entity_id)
        .await
        .unwrap();

    let p = updated
        .participants
        .iter()
        .find(|p| p.entity_id == alice.entity_id)
        .unwrap();
    assert!(p.confirmed);
    assert!(p.confirmed_at.is_some());
}

#[tokio::test]
async fn test_confirm_all_changes_status() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Test".to_string(),
        description: None,
        participants: vec![alice.clone(), bob.clone()],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None, address: None, city: None, place_id: None,
        video_url: None, phone_number: None, notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();
    service.confirm_participant(&meeting.id, &alice.entity_id).await.unwrap();
    let updated = service.confirm_participant(&meeting.id, &bob.entity_id).await.unwrap();

    assert_eq!(updated.status, MeetingStatus::Confirmed);
}

#[tokio::test]
async fn test_decline_triggers_rescheduling() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Test".to_string(),
        description: None,
        participants: vec![alice.clone(), bob],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None, address: None, city: None, place_id: None,
        video_url: None, phone_number: None, notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();
    let updated = service
        .decline_participant(&meeting.id, &alice.entity_id, Some("Conflict"))
        .await
        .unwrap();

    assert_eq!(updated.status, MeetingStatus::Rescheduling);
    assert!(updated.cancellation_reason.as_deref().unwrap().contains("Conflict"));
}

#[tokio::test]
async fn test_cancel_meeting() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Test".to_string(),
        description: None,
        participants: vec![alice, bob],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None, address: None, city: None, place_id: None,
        video_url: None, phone_number: None, notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();
    let cancelled = service
        .cancel_meeting(&meeting.id, Some("No longer needed"))
        .await
        .unwrap();

    assert_eq!(cancelled.status, MeetingStatus::Cancelled);
    assert_eq!(cancelled.cancellation_reason.as_deref(), Some("No longer needed"));
}

#[tokio::test]
async fn test_reschedule_meeting() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Test".to_string(),
        description: None,
        participants: vec![alice.clone(), bob],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None, address: None, city: None, place_id: None,
        video_url: None, phone_number: None, notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();

    // Confirm alice first
    service.confirm_participant(&meeting.id, &alice.entity_id).await.unwrap();

    let new_slot = TimeSlot {
        start: "2030-01-21T15:00:00+00:00".to_string(),
        end: "2030-01-21T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };

    let rescheduled = service
        .reschedule_meeting(&meeting.id, new_slot, Some("Better time"))
        .await
        .unwrap();

    assert!(rescheduled.slot.start.contains("2030-01-21"));
    assert_eq!(rescheduled.status, MeetingStatus::Proposed);
    assert_eq!(rescheduled.reschedule_count, 1);
    assert!(rescheduled.participants.iter().all(|p| !p.confirmed));
}

#[tokio::test]
async fn test_meeting_not_found() {
    let service = create_test_service();
    let result = service.confirm_participant("nonexistent", "entity-id").await;
    assert!(matches!(result, Err(SchedulingError::MeetingNotFound { .. })));
}

// ============================================================================
// CALENDAR INVITE TESTS
// ============================================================================

#[tokio::test]
async fn test_generate_invite() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Coffee Chat".to_string(),
        description: None,
        participants: vec![alice, bob],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None, address: None, city: None, place_id: None,
        video_url: Some("https://meet.example.com/abc".to_string()),
        phone_number: None, notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();
    let invite = service.generate_calendar_invite(&meeting, "alice@example.com", "Alice");

    assert_eq!(invite.recipient_email, "alice@example.com");
    assert_eq!(invite.recipient_name, "Alice");
    assert!(invite.ics.contains("BEGIN:VCALENDAR"));
    assert_eq!(invite.event.uid, meeting.id);
    assert_eq!(invite.event.title, "Coffee Chat");
}

#[tokio::test]
async fn test_send_invites() {
    let service = create_test_service();
    let (alice, bob) = sample_participants();

    let request = SchedulingRequest {
        id: "req-1".to_string(),
        room_id: "room-1".to_string(),
        title: "Test".to_string(),
        description: None,
        participants: vec![alice, bob],
        constraints: SchedulingConstraints::default(),
        urgency: SchedulingUrgency::Flexible,
        created_at: 0,
        max_proposals: 3,
    };

    let slot = TimeSlot {
        start: "2030-01-20T15:00:00+00:00".to_string(),
        end: "2030-01-20T16:00:00+00:00".to_string(),
        time_zone: "UTC".to_string(),
    };
    let location = MeetingLocation {
        location_type: LocationType::Virtual,
        name: None, address: None, city: None, place_id: None,
        video_url: None, phone_number: None, notes: None,
    };

    let meeting = service.create_meeting(&request, slot, location).await.unwrap();
    let invites = service.send_calendar_invites(&meeting).await.unwrap();
    assert_eq!(invites.len(), 2); // Alice and Bob both have emails
}

// ============================================================================
// FORMAT SLOT TEST
// ============================================================================

#[test]
fn test_format_slot() {
    let service = create_test_service();
    let slot = TimeSlot {
        start: "2025-01-20T15:00:00+00:00".to_string(),
        end: "2025-01-20T16:00:00+00:00".to_string(),
        time_zone: "America/New_York".to_string(),
    };
    let formatted = service.format_slot(&slot);
    assert!(formatted.contains("Mon"));
    assert!(formatted.contains("Jan"));
    assert!(formatted.contains("10:00")); // 15:00 UTC = 10:00 ET
}

// ============================================================================
// PROVIDER TESTS
// ============================================================================

#[test]
fn test_provider_metadata() {
    assert_eq!(SchedulingContextProvider::NAME, "SCHEDULING_CONTEXT");
    assert!(!SchedulingContextProvider::DESCRIPTION.is_empty());
}
