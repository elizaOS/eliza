//! ICS (iCalendar) file generation and parsing utilities.
//!
//! Generates RFC 5545 compliant iCalendar files for calendar invites.

use chrono::Utc;
use regex::Regex;

use crate::types::{CalendarEvent, ParticipantRole};

/// Escape special characters for ICS format.
pub fn escape_ics(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

/// Unescape ICS special characters.
pub fn unescape_ics(s: &str) -> String {
    s.replace("\\n", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

/// Format a date for ICS (YYYYMMDDTHHMMSSZ).
pub fn format_ics_date(iso_string: &str) -> String {
    let re_dash_colon = Regex::new(r"[-:]").unwrap();
    let without_dc = re_dash_colon.replace_all(iso_string, "");
    let re_ms = Regex::new(r"\.\d{3}").unwrap();
    re_ms.replace_all(&without_dc, "").to_string()
}

/// Parse ICS date format to ISO string.
pub fn parse_ics_date(ics_date: &str) -> String {
    let re = Regex::new(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$").unwrap();
    if let Some(caps) = re.captures(ics_date) {
        format!(
            "{}-{}-{}T{}:{}:{}Z",
            &caps[1], &caps[2], &caps[3], &caps[4], &caps[5], &caps[6]
        )
    } else {
        ics_date.to_string()
    }
}

/// Map participant role to ICS role.
pub fn ics_role(role: &ParticipantRole) -> &'static str {
    match role {
        ParticipantRole::Optional => "OPT-PARTICIPANT",
        _ => "REQ-PARTICIPANT",
    }
}

/// Fold long lines per RFC 5545 (max 75 octets per line).
pub fn fold_line(line: &str) -> String {
    let max_length = 75;
    if line.len() <= max_length {
        return line.to_string();
    }

    let mut lines: Vec<String> = Vec::new();
    let mut remaining = line;

    while !remaining.is_empty() {
        if lines.is_empty() {
            let end = remaining.len().min(max_length);
            lines.push(remaining[..end].to_string());
            remaining = &remaining[end..];
        } else {
            let end = remaining.len().min(max_length - 1);
            lines.push(format!(" {}", &remaining[..end]));
            remaining = &remaining[end..];
        }
    }

    lines.join("\r\n")
}

/// Generate ICS content for a calendar event.
pub fn generate_ics(event: &CalendarEvent) -> String {
    let mut lines: Vec<String> = Vec::new();

    // Begin calendar
    lines.push("BEGIN:VCALENDAR".to_string());
    lines.push("VERSION:2.0".to_string());
    lines.push("PRODID:-//elizaOS//SchedulingPlugin//EN".to_string());
    lines.push("CALSCALE:GREGORIAN".to_string());
    lines.push("METHOD:REQUEST".to_string());

    // Begin event
    lines.push("BEGIN:VEVENT".to_string());

    // Required properties
    lines.push(format!("UID:{}", event.uid));
    let now_stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    lines.push(format!("DTSTAMP:{}", now_stamp));
    lines.push(format!("DTSTART:{}", format_ics_date(&event.start)));
    lines.push(format!("DTEND:{}", format_ics_date(&event.end)));
    lines.push(format!("SUMMARY:{}", escape_ics(&event.title)));

    // Optional properties
    if let Some(ref desc) = event.description {
        lines.push(format!("DESCRIPTION:{}", escape_ics(desc)));
    }

    if let Some(ref location) = event.location {
        lines.push(format!("LOCATION:{}", escape_ics(location)));
    }

    if let Some(ref url) = event.url {
        lines.push(format!("URL:{}", url));
    }

    // Organizer
    if let Some(ref organizer) = event.organizer {
        lines.push(format!(
            "ORGANIZER;CN={}:mailto:{}",
            escape_ics(&organizer.name),
            organizer.email
        ));
    }

    // Attendees
    if let Some(ref attendees) = event.attendees {
        for attendee in attendees {
            let role = ics_role(&attendee.role);
            lines.push(format!(
                "ATTENDEE;ROLE={};PARTSTAT=NEEDS-ACTION;CN={}:mailto:{}",
                role,
                escape_ics(&attendee.name),
                attendee.email
            ));
        }
    }

    // Reminders/Alarms
    if let Some(ref reminder_mins) = event.reminder_minutes {
        for minutes in reminder_mins {
            lines.push("BEGIN:VALARM".to_string());
            lines.push("ACTION:DISPLAY".to_string());
            lines.push(format!("DESCRIPTION:{}", escape_ics(&event.title)));
            lines.push(format!("TRIGGER:-PT{}M", minutes));
            lines.push("END:VALARM".to_string());
        }
    }

    // Status
    lines.push("STATUS:CONFIRMED".to_string());
    lines.push("SEQUENCE:0".to_string());

    // End event
    lines.push("END:VEVENT".to_string());

    // End calendar
    lines.push("END:VCALENDAR".to_string());

    // Fold long lines and join with CRLF
    lines
        .iter()
        .map(|l| fold_line(l))
        .collect::<Vec<_>>()
        .join("\r\n")
}

/// Parse an ICS file and extract events (basic parser).
pub fn parse_ics(ics: &str) -> Vec<CalendarEvent> {
    let mut events: Vec<CalendarEvent> = Vec::new();
    let lines: Vec<&str> = ics.split('\n').collect();

    let mut current_event: Option<PartialEvent> = None;
    let mut current_line = String::new();

    for line in &lines {
        let line = line.trim_end_matches('\r');

        // Handle line folding
        if line.starts_with(' ') || line.starts_with('\t') {
            current_line.push_str(&line[1..]);
            continue;
        }

        // Process previous line
        if !current_line.is_empty() {
            if let Some(ref mut evt) = current_event {
                process_line(&current_line, evt);
            }
        }

        current_line = line.to_string();

        if line == "BEGIN:VEVENT" {
            current_event = Some(PartialEvent::default());
        } else if line == "END:VEVENT" {
            if let Some(evt) = current_event.take() {
                if let (Some(uid), Some(title), Some(start), Some(end)) =
                    (evt.uid, evt.title, evt.start, evt.end)
                {
                    events.push(CalendarEvent {
                        uid,
                        title,
                        description: evt.description,
                        start,
                        end,
                        time_zone: evt.time_zone.unwrap_or_else(|| "UTC".to_string()),
                        location: evt.location,
                        organizer: None,
                        attendees: None,
                        url: evt.url,
                        reminder_minutes: None,
                    });
                }
            }
            current_event = None;
        }
    }

    events
}

#[derive(Default)]
struct PartialEvent {
    uid: Option<String>,
    title: Option<String>,
    description: Option<String>,
    start: Option<String>,
    end: Option<String>,
    time_zone: Option<String>,
    location: Option<String>,
    url: Option<String>,
}

fn process_line(line: &str, event: &mut PartialEvent) {
    if let Some(colon_idx) = line.find(':') {
        let key_part = &line[..colon_idx];
        let value = &line[colon_idx + 1..];

        let key = if let Some(semi_idx) = key_part.find(';') {
            &key_part[..semi_idx]
        } else {
            key_part
        };

        match key {
            "UID" => event.uid = Some(value.to_string()),
            "SUMMARY" => event.title = Some(unescape_ics(value)),
            "DESCRIPTION" => event.description = Some(unescape_ics(value)),
            "DTSTART" => event.start = Some(parse_ics_date(value)),
            "DTEND" => event.end = Some(parse_ics_date(value)),
            "LOCATION" => event.location = Some(unescape_ics(value)),
            "URL" => event.url = Some(value.to_string()),
            _ => {}
        }
    }
}
