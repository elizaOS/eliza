//! SET_AVAILABILITY action.
//!
//! Parses natural language availability ("weekdays 9-5", "monday afternoons")
//! and saves to scheduling service.

use regex::Regex;
use std::collections::HashMap;

use crate::types::{AvailabilityWindow, DayOfWeek};

/// Time preset ranges (start_minutes, end_minutes).
pub fn time_presets() -> HashMap<&'static str, (u16, u16)> {
    let mut m = HashMap::new();
    m.insert("morning", (540u16, 720u16));
    m.insert("afternoon", (720, 1020));
    m.insert("evening", (1020, 1260));
    m.insert("business hours", (540, 1020));
    m.insert("work hours", (540, 1020));
    m
}

/// Parse a time string to minutes from midnight.
pub fn parse_time_to_minutes(time_str: &str) -> Option<u16> {
    let normalized = time_str.to_lowercase();
    let normalized = normalized.trim();

    // Try "HH:MM" 24-hour format
    let re_24 = Regex::new(r"^(\d{1,2}):(\d{2})$").unwrap();
    if let Some(caps) = re_24.captures(normalized) {
        let hours: u16 = caps[1].parse().ok()?;
        let minutes: u16 = caps[2].parse().ok()?;
        if hours < 24 && minutes < 60 {
            return Some(hours * 60 + minutes);
        }
    }

    // Try "H:MMam/pm" or "HHam/pm" format
    let re_12 = Regex::new(r"(?i)^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$").unwrap();
    if let Some(caps) = re_12.captures(normalized) {
        let mut hours: u16 = caps[1].parse().ok()?;
        let minutes: u16 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        let is_pm = caps[3].to_lowercase() == "pm";

        if hours == 12 {
            hours = if is_pm { 12 } else { 0 };
        } else if is_pm {
            hours += 12;
        }

        if hours < 24 && minutes < 60 {
            return Some(hours * 60 + minutes);
        }
    }

    None
}

/// Parse a day string to a list of DayOfWeek values.
pub fn parse_days(day_str: &str) -> Vec<DayOfWeek> {
    let normalized = day_str.to_lowercase();
    let normalized = normalized.trim();

    match normalized {
        "weekday" | "weekdays" => DayOfWeek::weekdays(),
        "weekend" | "weekends" => DayOfWeek::weekends(),
        "everyday" | "every day" | "daily" => DayOfWeek::all(),
        _ => {
            let day_map: HashMap<&str, DayOfWeek> = HashMap::from([
                ("monday", DayOfWeek::Mon), ("mon", DayOfWeek::Mon),
                ("tuesday", DayOfWeek::Tue), ("tue", DayOfWeek::Tue),
                ("wednesday", DayOfWeek::Wed), ("wed", DayOfWeek::Wed),
                ("thursday", DayOfWeek::Thu), ("thu", DayOfWeek::Thu),
                ("friday", DayOfWeek::Fri), ("fri", DayOfWeek::Fri),
                ("saturday", DayOfWeek::Sat), ("sat", DayOfWeek::Sat),
                ("sunday", DayOfWeek::Sun), ("sun", DayOfWeek::Sun),
            ]);
            day_map.get(normalized).map(|d| vec![*d]).unwrap_or_default()
        }
    }
}

/// Result of parsing availability text.
#[derive(Debug)]
pub struct ParsedAvailability {
    pub windows: Vec<AvailabilityWindow>,
    pub time_zone: Option<String>,
}

/// Parse natural language availability into structured windows.
pub fn parse_availability_text(text: &str) -> Option<ParsedAvailability> {
    let normalized = text.to_lowercase();
    let mut windows: Vec<AvailabilityWindow> = Vec::new();

    // Try to extract time zone
    let tz_re = Regex::new(
        r"(?i)(?:time\s*zone|tz|timezone)[\s:]*([A-Za-z_/]+)|(?i)(America/[A-Za-z_]+|Europe/[A-Za-z_]+|Asia/[A-Za-z_]+|Pacific/[A-Za-z_]+|UTC)"
    ).unwrap();
    let time_zone = tz_re.captures(text).and_then(|caps| {
        caps.get(1).or(caps.get(2)).map(|m| m.as_str().to_string())
    });

    // Pattern: "weekdays 9am to 5pm" or "monday 10am-2pm"
    let day_time_re = Regex::new(
        r"(?i)(weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|daily|every\s*day)(?:\s+(?:and\s+)?(?:weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun))*\s+(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)"
    ).unwrap();

    for caps in day_time_re.captures_iter(&normalized) {
        let day_part = &caps[1];
        let start_time = &caps[2];
        let end_time = &caps[3];

        let days = parse_days(day_part);
        if let (Some(start_mins), Some(end_mins)) =
            (parse_time_to_minutes(start_time), parse_time_to_minutes(end_time))
        {
            for day in &days {
                windows.push(AvailabilityWindow {
                    day: *day,
                    start_minutes: start_mins,
                    end_minutes: end_mins,
                });
            }
        }
    }

    // Pattern: "weekday mornings" or "monday afternoons"
    let day_preset_re = Regex::new(
        r"(?i)(weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|daily|every\s*day)\s+(morning|afternoon|evening|business\s*hours?|work\s*hours?)"
    ).unwrap();

    let presets = time_presets();
    for caps in day_preset_re.captures_iter(&normalized) {
        let day_part = &caps[1];
        let time_part = caps[2].to_lowercase();

        let days = parse_days(day_part);
        let time_range = presets.get(time_part.as_str())
            .or_else(|| presets.get(time_part.trim_end_matches('s')));

        if let Some(&(start, end)) = time_range {
            for day in &days {
                let exists = windows.iter().any(|w| {
                    w.day == *day && w.start_minutes == start && w.end_minutes == end
                });
                if !exists {
                    windows.push(AvailabilityWindow {
                        day: *day,
                        start_minutes: start,
                        end_minutes: end,
                    });
                }
            }
        }
    }

    // Fallback: "I'm free mornings" (assume weekdays)
    if windows.is_empty() {
        for (preset, &(start, end)) in &presets {
            if normalized.contains(preset) {
                for day in DayOfWeek::weekdays() {
                    windows.push(AvailabilityWindow {
                        day,
                        start_minutes: start,
                        end_minutes: end,
                    });
                }
                break;
            }
        }
    }

    if windows.is_empty() {
        return None;
    }

    Some(ParsedAvailability { windows, time_zone })
}

/// Format minutes-from-midnight as a human-readable time.
pub fn format_time(minutes: u16) -> String {
    let hours = minutes / 60;
    let mins = minutes % 60;
    let period = if hours >= 12 { "pm" } else { "am" };
    let display_hours = if hours > 12 {
        hours - 12
    } else if hours == 0 {
        12
    } else {
        hours
    };
    if mins > 0 {
        format!("{}:{:02}{}", display_hours, mins, period)
    } else {
        format!("{}{}", display_hours, period)
    }
}

/// SET_AVAILABILITY action metadata and validation.
pub struct SetAvailabilityAction;

impl SetAvailabilityAction {
    pub const NAME: &'static str = "SET_AVAILABILITY";
    pub const SIMILES: &'static [&'static str] = &[
        "UPDATE_AVAILABILITY",
        "SET_SCHEDULE",
        "UPDATE_SCHEDULE",
        "SET_FREE_TIME",
        "WHEN_FREE",
    ];
    pub const DESCRIPTION: &'static str =
        "Set the user's availability for scheduling meetings";

    /// Validate if this message should trigger the SET_AVAILABILITY action.
    pub fn validate(text: &str) -> bool {
        let lower = text.to_lowercase();
        lower.contains("available")
            || lower.contains("availability")
            || lower.contains("free on")
            || lower.contains("i'm free")
            || lower.contains("can meet")
            || lower.contains("my time")
            || lower.contains("morning")
            || lower.contains("afternoon")
            || lower.contains("evening")
    }
}
