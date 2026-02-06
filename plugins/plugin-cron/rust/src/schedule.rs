use chrono::{DateTime, Datelike, Duration, NaiveTime, Timelike, Utc};
use regex::Regex;

use crate::types::ScheduleType;

// ---------------------------------------------------------------------------
// Cron expression validation
// ---------------------------------------------------------------------------

/// Validates a standard 5-field cron expression.
///
/// Fields: minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-7)
/// Supports: `*`, numbers, ranges (`1-5`), steps (`*/5`), and lists (`1,3,5`).
pub fn validate_cron_expression(expr: &str) -> bool {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return false;
    }

    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }

    let ranges = [(0u32, 59), (0, 23), (1, 31), (1, 12), (0, 7)];

    for (field, &(min, max)) in fields.iter().zip(ranges.iter()) {
        if !validate_cron_field(field, min, max) {
            return false;
        }
    }

    true
}

fn validate_cron_field(field: &str, min: u32, max: u32) -> bool {
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return false;
        }

        if part == "*" {
            continue;
        }

        // Handle step values: */2, 1-5/2
        if let Some((base, step_str)) = part.split_once('/') {
            let step: u32 = match step_str.parse() {
                Ok(s) if s > 0 => s,
                _ => return false,
            };
            if step > max {
                return false;
            }
            if base == "*" {
                continue;
            }
            // base must be a range or number
            if !validate_cron_range_or_number(base, min, max) {
                return false;
            }
            continue;
        }

        // Handle ranges: 1-5
        if part.contains('-') {
            if !validate_cron_range_or_number(part, min, max) {
                return false;
            }
            continue;
        }

        // Plain number
        match part.parse::<u32>() {
            Ok(n) if n >= min && n <= max => {}
            _ => return false,
        }
    }
    true
}

fn validate_cron_range_or_number(s: &str, min: u32, max: u32) -> bool {
    if let Some((lo_str, hi_str)) = s.split_once('-') {
        let lo: u32 = match lo_str.parse() {
            Ok(n) => n,
            _ => return false,
        };
        let hi: u32 = match hi_str.parse() {
            Ok(n) => n,
            _ => return false,
        };
        lo >= min && hi <= max && lo <= hi
    } else {
        match s.parse::<u32>() {
            Ok(n) => n >= min && n <= max,
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Schedule parsing
// ---------------------------------------------------------------------------

/// Parses a schedule string into a `ScheduleType`.
///
/// Accepted formats:
/// - ISO 8601 datetime → `At`
/// - Duration string (e.g. `30s`, `5m`, `2h`, `1d`) → `Every`
/// - 5-field cron expression → `Cron`
pub fn parse_schedule(input: &str) -> Result<ScheduleType, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Empty schedule string".to_string());
    }

    // Try ISO 8601 datetime
    if let Ok(dt) = trimmed.parse::<DateTime<Utc>>() {
        return Ok(ScheduleType::At { at: dt });
    }

    // Try duration
    if let Some(dur) = parse_duration(trimmed) {
        return Ok(ScheduleType::Every { interval: dur });
    }

    // Try cron expression
    if validate_cron_expression(trimmed) {
        return Ok(ScheduleType::Cron {
            expr: trimmed.to_string(),
        });
    }

    Err(format!("Cannot parse schedule: {}", trimmed))
}

/// Parses a duration string like `30s`, `5m`, `2h`, `1d` into a `chrono::Duration`.
pub fn parse_duration(input: &str) -> Option<Duration> {
    let re = Regex::new(r"^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$")
        .ok()?;
    let caps = re.captures(input.trim())?;

    let value: f64 = caps.get(1)?.as_str().parse().ok()?;
    if value <= 0.0 || !value.is_finite() {
        return None;
    }

    let unit = caps.get(2)?.as_str().to_lowercase();
    let ms = if unit.starts_with('s') {
        (value * 1_000.0).round() as i64
    } else if unit.starts_with('m') {
        (value * 60_000.0).round() as i64
    } else if unit.starts_with('h') {
        (value * 3_600_000.0).round() as i64
    } else if unit.starts_with('d') {
        (value * 86_400_000.0).round() as i64
    } else {
        return None;
    };

    if ms <= 0 {
        return None;
    }

    Duration::try_milliseconds(ms)
}

// ---------------------------------------------------------------------------
// Next-run computation
// ---------------------------------------------------------------------------

/// Computes the next run time from a given reference point.
pub fn compute_next_run(schedule: &ScheduleType, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    match schedule {
        ScheduleType::At { at } => {
            if *at > from {
                Some(*at)
            } else {
                None
            }
        }
        ScheduleType::Every { interval } => {
            let millis = interval.num_milliseconds();
            if millis <= 0 {
                return None;
            }
            Some(from + *interval)
        }
        ScheduleType::Cron { expr } => compute_next_cron_run(expr, from),
    }
}

/// Computes the next run time for a 5-field cron expression starting strictly after `from`.
fn compute_next_cron_run(expr: &str, from: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let fields: Vec<&str> = expr.trim().split_whitespace().collect();
    if fields.len() != 5 {
        return None;
    }

    let minutes = expand_cron_field(fields[0], 0, 59)?;
    let hours = expand_cron_field(fields[1], 0, 23)?;
    let doms = expand_cron_field(fields[2], 1, 31)?;
    let months = expand_cron_field(fields[3], 1, 12)?;
    let dows = expand_cron_field(fields[4], 0, 7)?;

    // Normalize dow=7 → dow=0 (both mean Sunday)
    let dows: Vec<u32> = dows
        .into_iter()
        .map(|d| if d == 7 { 0 } else { d })
        .collect();

    // Search forward up to 366 days from `from`
    let mut candidate = from + Duration::try_minutes(1)?;
    // Snap to start of minute
    candidate = candidate
        .date_naive()
        .and_hms_opt(candidate.hour(), candidate.minute(), 0)?
        .and_utc();

    let limit = from + Duration::try_days(366)?;

    while candidate < limit {
        let m = candidate.month();
        if !months.contains(&m) {
            // Skip to first day of next month
            candidate = advance_month(candidate)?;
            continue;
        }

        let dom = candidate.day();
        let dow = candidate.weekday().num_days_from_sunday(); // 0=Sun

        let dom_match = doms.contains(&dom);
        let dow_match = dows.contains(&dow);

        // Cron logic: if both dom and dow are restricted (not `*`), match if EITHER is true
        let dom_is_star = fields[2].trim() == "*";
        let dow_is_star = fields[4].trim() == "*";

        let day_ok = if dom_is_star && dow_is_star {
            true
        } else if dom_is_star {
            dow_match
        } else if dow_is_star {
            dom_match
        } else {
            dom_match || dow_match
        };

        if !day_ok {
            candidate = candidate + Duration::try_days(1)?;
            candidate = candidate
                .date_naive()
                .and_hms_opt(0, 0, 0)?
                .and_utc();
            continue;
        }

        if !hours.contains(&candidate.hour()) {
            candidate = candidate + Duration::try_hours(1)?;
            candidate = candidate
                .date_naive()
                .and_hms_opt(candidate.hour(), 0, 0)?
                .and_utc();
            continue;
        }

        if !minutes.contains(&candidate.minute()) {
            candidate = candidate + Duration::try_minutes(1)?;
            continue;
        }

        return Some(candidate);
    }

    None
}

/// Advances to 00:00 on the first day of the next month.
fn advance_month(dt: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let (y, m) = if dt.month() == 12 {
        (dt.year() + 1, 1)
    } else {
        (dt.year(), dt.month() + 1)
    };
    let naive = chrono::NaiveDate::from_ymd_opt(y, m, 1)?
        .and_time(NaiveTime::from_hms_opt(0, 0, 0)?);
    Some(naive.and_utc())
}

/// Expands a single cron field into the set of matching values.
fn expand_cron_field(field: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut result = Vec::new();
    for part in field.split(',') {
        let part = part.trim();
        if part == "*" {
            return Some((min..=max).collect());
        }

        if let Some((base, step_str)) = part.split_once('/') {
            let step: u32 = step_str.parse().ok()?;
            if step == 0 {
                return None;
            }

            let (range_min, range_max) = if base == "*" {
                (min, max)
            } else if let Some((lo, hi)) = base.split_once('-') {
                (lo.parse().ok()?, hi.parse().ok()?)
            } else {
                let start: u32 = base.parse().ok()?;
                (start, max)
            };

            let mut v = range_min;
            while v <= range_max {
                result.push(v);
                v += step;
            }
            continue;
        }

        if let Some((lo_str, hi_str)) = part.split_once('-') {
            let lo: u32 = lo_str.parse().ok()?;
            let hi: u32 = hi_str.parse().ok()?;
            for v in lo..=hi {
                result.push(v);
            }
            continue;
        }

        result.push(part.parse().ok()?);
    }

    result.sort();
    result.dedup();
    Some(result)
}

// ---------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------

/// Formats a `ScheduleType` as a human-readable string.
pub fn format_schedule(schedule: &ScheduleType) -> String {
    match schedule {
        ScheduleType::At { at } => format!("once at {}", at.format("%Y-%m-%d %H:%M:%S UTC")),
        ScheduleType::Every { interval } => {
            let total_ms = interval.num_milliseconds();
            if total_ms >= 86_400_000 {
                let days = total_ms / 86_400_000;
                format!("every {} day{}", days, if days == 1 { "" } else { "s" })
            } else if total_ms >= 3_600_000 {
                let hours = total_ms / 3_600_000;
                format!("every {} hour{}", hours, if hours == 1 { "" } else { "s" })
            } else if total_ms >= 60_000 {
                let minutes = total_ms / 60_000;
                format!(
                    "every {} minute{}",
                    minutes,
                    if minutes == 1 { "" } else { "s" }
                )
            } else {
                let seconds = total_ms / 1_000;
                format!(
                    "every {} second{}",
                    seconds,
                    if seconds == 1 { "" } else { "s" }
                )
            }
        }
        ScheduleType::Cron { expr } => format!("cron: {}", expr),
    }
}

// ---------------------------------------------------------------------------
// Natural language schedule parsing
// ---------------------------------------------------------------------------

/// Parses simple natural language schedule descriptions.
///
/// Supported patterns:
/// - `"every 5 minutes"`, `"every 2 hours"`, `"every 30 seconds"`, `"every day"`
/// - `"daily at 9am"`, `"daily at 14:30"`
/// - `"hourly"`, `"daily"`, `"weekly"`
pub fn parse_natural_language_schedule(text: &str) -> Option<ScheduleType> {
    let normalized = text.trim().to_lowercase();

    // "every N unit(s)"
    let every_re =
        Regex::new(r"^every\s+(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?)$").ok()?;
    if let Some(caps) = every_re.captures(&normalized) {
        let value: i64 = caps.get(1)?.as_str().parse().ok()?;
        let unit = caps.get(2)?.as_str();
        let ms = match unit.chars().next()? {
            's' => value * 1_000,
            'm' => value * 60_000,
            'h' => value * 3_600_000,
            'd' => value * 86_400_000,
            'w' => value * 604_800_000,
            _ => return None,
        };
        return Some(ScheduleType::Every {
            interval: Duration::try_milliseconds(ms)?,
        });
    }

    // "every <unit>" without number (e.g. "every minute")
    let every_single =
        Regex::new(r"^every\s+(second|minute|hour|day|week)$").ok()?;
    if let Some(caps) = every_single.captures(&normalized) {
        let unit = caps.get(1)?.as_str();
        let ms: i64 = match unit {
            "second" => 1_000,
            "minute" => 60_000,
            "hour" => 3_600_000,
            "day" => 86_400_000,
            "week" => 604_800_000,
            _ => return None,
        };
        return Some(ScheduleType::Every {
            interval: Duration::try_milliseconds(ms)?,
        });
    }

    // "daily at HH:MM" or "daily at Ham/Hpm"
    let daily_at = Regex::new(r"^daily\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$").ok()?;
    if let Some(caps) = daily_at.captures(&normalized) {
        let mut hour: u32 = caps.get(1)?.as_str().parse().ok()?;
        let minute: u32 = caps
            .get(2)
            .map(|m| m.as_str().parse().unwrap_or(0))
            .unwrap_or(0);
        if let Some(ampm) = caps.get(3) {
            match ampm.as_str() {
                "pm" if hour != 12 => hour += 12,
                "am" if hour == 12 => hour = 0,
                _ => {}
            }
        }
        if hour > 23 || minute > 59 {
            return None;
        }
        return Some(ScheduleType::Cron {
            expr: format!("{} {} * * *", minute, hour),
        });
    }

    // Shorthand keywords
    match normalized.as_str() {
        "hourly" => Some(ScheduleType::Cron {
            expr: "0 * * * *".to_string(),
        }),
        "daily" => Some(ScheduleType::Cron {
            expr: "0 0 * * *".to_string(),
        }),
        "weekly" => Some(ScheduleType::Cron {
            expr: "0 0 * * 0".to_string(),
        }),
        _ => None,
    }
}
