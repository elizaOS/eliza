//! Smart TTL (Time-To-Live) management for form sessions.
//!
//! TTL is effort-based: the more time a user spends on a form, the longer
//! we keep it. This prevents losing significant work while cleaning up
//! abandoned forms.
//!
//! | Time Spent | Extra Days | Total TTL |
//! |------------|------------|-----------|
//! | 0 min      | 0          | 14 days   |
//! | 10 min     | 5          | 14 days   |
//! | 30 min     | 15         | 15 days   |
//! | 2 hours    | 60         | 60 days   |
//! | 4 hours    | 120        | 90 days   |

use crate::types::{
    FormDefinition, FormSession, DEFAULT_NUDGE_AFTER_INACTIVE_HOURS, DEFAULT_NUDGE_MAX_NUDGES,
    DEFAULT_TTL_EFFORT_MULTIPLIER, DEFAULT_TTL_MAX_DAYS, DEFAULT_TTL_MIN_DAYS,
};

/// Calculate TTL based on user effort. Returns expiration timestamp (ms).
///
/// The `now` parameter allows deterministic testing.
pub fn calculate_ttl(session: &FormSession, form: Option<&FormDefinition>, now: i64) -> i64 {
    let (min_days, max_days, multiplier) = ttl_config(form);

    let minutes_spent = session.effort.time_spent_ms as f64 / 60_000.0;
    let effort_days = minutes_spent * multiplier;
    let ttl_days = max_days.min(min_days.max(effort_days));

    now + (ttl_days * 24.0 * 60.0 * 60.0 * 1000.0) as i64
}

/// Check if session should be nudged.
///
/// Conditions: nudging enabled, under max nudges, inactive long enough,
/// and at least 24h since last nudge.
pub fn should_nudge(session: &FormSession, form: Option<&FormDefinition>, now: i64) -> bool {
    let (nudge_enabled, after_hours, max_nudges) = nudge_config(form);

    if !nudge_enabled {
        return false;
    }

    if session.nudge_count.unwrap_or(0) >= max_nudges {
        return false;
    }

    let inactive_ms = (after_hours * 60.0 * 60.0 * 1000.0) as i64;
    let time_since_interaction = now - session.effort.last_interaction_at;
    if time_since_interaction < inactive_ms {
        return false;
    }

    // At least 24h between nudges
    if let Some(last_nudge) = session.last_nudge_at {
        let time_since_nudge = now - last_nudge;
        if time_since_nudge < 24 * 60 * 60 * 1000 {
            return false;
        }
    }

    true
}

/// Check if session is expiring soon (within `within_ms` milliseconds).
pub fn is_expiring_soon(session: &FormSession, within_ms: i64, now: i64) -> bool {
    session.expires_at - now < within_ms
}

/// Check if session has expired.
pub fn is_expired(session: &FormSession, now: i64) -> bool {
    session.expires_at < now
}

/// Check if we should confirm before canceling (high-effort sessions).
///
/// Threshold: 5 minutes of effort.
pub fn should_confirm_cancel(session: &FormSession) -> bool {
    let min_effort_ms = 5 * 60 * 1000;
    session.effort.time_spent_ms > min_effort_ms
}

/// Format remaining time for user display.
pub fn format_time_remaining(session: &FormSession, now: i64) -> String {
    let remaining = session.expires_at - now;

    if remaining <= 0 {
        return "expired".to_string();
    }

    let hours = remaining / (60 * 60 * 1000);
    let days = hours / 24;

    if days > 0 {
        return format!("{} day{}", days, if days > 1 { "s" } else { "" });
    }

    if hours > 0 {
        return format!("{} hour{}", hours, if hours > 1 { "s" } else { "" });
    }

    let minutes = remaining / (60 * 1000);
    format!("{} minute{}", minutes, if minutes > 1 { "s" } else { "" })
}

/// Format effort for user display.
pub fn format_effort(session: &FormSession) -> String {
    let minutes = session.effort.time_spent_ms / 60_000;

    if minutes < 1 {
        return "just started".to_string();
    }

    if minutes < 60 {
        return format!("{} minute{}", minutes, if minutes > 1 { "s" } else { "" });
    }

    let hours = minutes / 60;
    let remaining_minutes = minutes % 60;

    if remaining_minutes == 0 {
        return format!("{} hour{}", hours, if hours > 1 { "s" } else { "" });
    }

    format!("{}h {}m", hours, remaining_minutes)
}

// ============================================================================
// HELPERS
// ============================================================================

fn ttl_config(form: Option<&FormDefinition>) -> (f64, f64, f64) {
    let ttl = form.and_then(|f| f.ttl.as_ref());
    let min_days = ttl
        .and_then(|t| t.min_days)
        .unwrap_or(DEFAULT_TTL_MIN_DAYS);
    let max_days = ttl
        .and_then(|t| t.max_days)
        .unwrap_or(DEFAULT_TTL_MAX_DAYS);
    let multiplier = ttl
        .and_then(|t| t.effort_multiplier)
        .unwrap_or(DEFAULT_TTL_EFFORT_MULTIPLIER);
    (min_days, max_days, multiplier)
}

fn nudge_config(form: Option<&FormDefinition>) -> (bool, f64, u32) {
    let nudge = form.and_then(|f| f.nudge.as_ref());
    let enabled = nudge.and_then(|n| n.enabled).unwrap_or(true);
    let after_hours = nudge
        .and_then(|n| n.after_inactive_hours)
        .unwrap_or(DEFAULT_NUDGE_AFTER_INACTIVE_HOURS);
    let max_nudges = nudge
        .and_then(|n| n.max_nudges)
        .unwrap_or(DEFAULT_NUDGE_MAX_NUDGES);
    (enabled, after_hours, max_nudges)
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        FormDefinitionNudge, FormDefinitionTTL, SessionEffort, SessionStatus,
    };
    use std::collections::HashMap;

    const HOUR_MS: i64 = 60 * 60 * 1000;
    const DAY_MS: i64 = 24 * HOUR_MS;
    const NOW: i64 = 1_700_000_000_000;

    fn make_session(time_spent_ms: i64, last_interaction_at: i64) -> FormSession {
        FormSession {
            id: "s1".to_string(),
            form_id: "f1".to_string(),
            form_version: None,
            entity_id: "e1".to_string(),
            room_id: "r1".to_string(),
            status: SessionStatus::Active,
            fields: HashMap::new(),
            history: Vec::new(),
            parent_session_id: None,
            context: None,
            locale: None,
            last_asked_field: None,
            last_message_id: None,
            cancel_confirmation_asked: None,
            effort: SessionEffort {
                interaction_count: 5,
                time_spent_ms,
                first_interaction_at: NOW - time_spent_ms,
                last_interaction_at,
            },
            expires_at: NOW + 14 * DAY_MS,
            expiration_warned: None,
            nudge_count: None,
            last_nudge_at: None,
            created_at: NOW - time_spent_ms,
            updated_at: last_interaction_at,
            submitted_at: None,
            meta: None,
        }
    }

    fn make_form(ttl: Option<FormDefinitionTTL>, nudge: Option<FormDefinitionNudge>) -> FormDefinition {
        FormDefinition {
            id: "f1".to_string(),
            name: "Test Form".to_string(),
            controls: vec![],
            ttl,
            nudge,
            ..Default::default()
        }
    }

    // ═══ TTL CALCULATION ═══

    #[test]
    fn test_ttl_zero_effort_equals_min_days() {
        let session = make_session(0, NOW);
        let expires = calculate_ttl(&session, None, NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 14.0).abs() < 0.01);
    }

    #[test]
    fn test_ttl_low_effort_still_min_days() {
        // 5 min * 0.5 = 2.5 extra days -> still 14 min
        let session = make_session(5 * 60_000, NOW);
        let expires = calculate_ttl(&session, None, NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 14.0).abs() < 0.01);
    }

    #[test]
    fn test_ttl_medium_effort() {
        // 2 hours = 120 min * 0.5 = 60 days
        let session = make_session(120 * 60_000, NOW);
        let expires = calculate_ttl(&session, None, NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 60.0).abs() < 0.01);
    }

    #[test]
    fn test_ttl_high_effort_capped_at_max() {
        // 4 hours = 240 min * 0.5 = 120 days, capped to 90
        let session = make_session(240 * 60_000, NOW);
        let expires = calculate_ttl(&session, None, NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 90.0).abs() < 0.01);
    }

    #[test]
    fn test_ttl_very_high_effort_still_max() {
        let session = make_session(600 * 60_000, NOW);
        let expires = calculate_ttl(&session, None, NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 90.0).abs() < 0.01);
    }

    #[test]
    fn test_ttl_custom_min_days() {
        let form = make_form(
            Some(FormDefinitionTTL {
                min_days: Some(7.0),
                max_days: None,
                effort_multiplier: None,
            }),
            None,
        );
        let session = make_session(0, NOW);
        let expires = calculate_ttl(&session, Some(&form), NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 7.0).abs() < 0.01);
    }

    #[test]
    fn test_ttl_custom_max_days() {
        let form = make_form(
            Some(FormDefinitionTTL {
                min_days: None,
                max_days: Some(30.0),
                effort_multiplier: None,
            }),
            None,
        );
        let session = make_session(600 * 60_000, NOW);
        let expires = calculate_ttl(&session, Some(&form), NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 30.0).abs() < 0.01);
    }

    #[test]
    fn test_ttl_custom_multiplier() {
        let form = make_form(
            Some(FormDefinitionTTL {
                min_days: None,
                max_days: None,
                effort_multiplier: Some(1.0),
            }),
            None,
        );
        // 60 min * 1.0 = 60 days
        let session = make_session(60 * 60_000, NOW);
        let expires = calculate_ttl(&session, Some(&form), NOW);
        let days = (expires - NOW) as f64 / DAY_MS as f64;
        assert!((days - 60.0).abs() < 0.01);
    }

    // ═══ NUDGE ═══

    #[test]
    fn test_should_nudge_after_inactivity() {
        let session = make_session(60_000, NOW - 49 * HOUR_MS);
        assert!(should_nudge(&session, None, NOW));
    }

    #[test]
    fn test_should_not_nudge_when_active() {
        let session = make_session(60_000, NOW - HOUR_MS);
        assert!(!should_nudge(&session, None, NOW));
    }

    #[test]
    fn test_should_not_nudge_when_disabled() {
        let form = make_form(
            None,
            Some(FormDefinitionNudge {
                enabled: Some(false),
                after_inactive_hours: None,
                max_nudges: None,
                message: None,
            }),
        );
        let session = make_session(60_000, NOW - 49 * HOUR_MS);
        assert!(!should_nudge(&session, Some(&form), NOW));
    }

    #[test]
    fn test_should_not_nudge_at_max() {
        let mut session = make_session(60_000, NOW - 49 * HOUR_MS);
        session.nudge_count = Some(3);
        assert!(!should_nudge(&session, None, NOW));
    }

    #[test]
    fn test_should_not_nudge_recently_nudged() {
        let mut session = make_session(60_000, NOW - 49 * HOUR_MS);
        session.last_nudge_at = Some(NOW - 12 * HOUR_MS); // 12h ago
        assert!(!should_nudge(&session, None, NOW));
    }

    #[test]
    fn test_should_nudge_after_24h_since_last() {
        let mut session = make_session(60_000, NOW - 49 * HOUR_MS);
        session.last_nudge_at = Some(NOW - 25 * HOUR_MS);
        session.nudge_count = Some(1);
        assert!(should_nudge(&session, None, NOW));
    }

    #[test]
    fn test_should_nudge_custom_hours() {
        let form = make_form(
            None,
            Some(FormDefinitionNudge {
                enabled: Some(true),
                after_inactive_hours: Some(12.0),
                max_nudges: None,
                message: None,
            }),
        );
        let session = make_session(60_000, NOW - 13 * HOUR_MS);
        assert!(should_nudge(&session, Some(&form), NOW));
    }

    // ═══ EXPIRATION ═══

    #[test]
    fn test_is_expiring_soon_true() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + 12 * HOUR_MS;
        assert!(is_expiring_soon(&session, 24 * HOUR_MS, NOW));
    }

    #[test]
    fn test_is_expiring_soon_false() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + 48 * HOUR_MS;
        assert!(!is_expiring_soon(&session, 24 * HOUR_MS, NOW));
    }

    #[test]
    fn test_is_expired_true() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW - 1000;
        assert!(is_expired(&session, NOW));
    }

    #[test]
    fn test_is_expired_false() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + DAY_MS;
        assert!(!is_expired(&session, NOW));
    }

    #[test]
    fn test_is_expired_boundary() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW;
        assert!(!is_expired(&session, NOW)); // exactly at expiry is not expired
    }

    // ═══ CANCEL CONFIRMATION ═══

    #[test]
    fn test_confirm_cancel_high_effort() {
        let session = make_session(6 * 60_000, NOW); // 6 min
        assert!(should_confirm_cancel(&session));
    }

    #[test]
    fn test_no_confirm_cancel_low_effort() {
        let session = make_session(2 * 60_000, NOW); // 2 min
        assert!(!should_confirm_cancel(&session));
    }

    #[test]
    fn test_no_confirm_cancel_boundary() {
        let session = make_session(5 * 60_000, NOW); // exactly 5 min
        assert!(!should_confirm_cancel(&session));
    }

    // ═══ FORMAT TIME REMAINING ═══

    #[test]
    fn test_format_time_days() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + 14 * DAY_MS;
        assert_eq!(format_time_remaining(&session, NOW), "14 days");
    }

    #[test]
    fn test_format_time_one_day() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + DAY_MS + HOUR_MS;
        assert_eq!(format_time_remaining(&session, NOW), "1 day");
    }

    #[test]
    fn test_format_time_hours() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + 5 * HOUR_MS;
        assert_eq!(format_time_remaining(&session, NOW), "5 hours");
    }

    #[test]
    fn test_format_time_one_hour() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + HOUR_MS + 30 * 60_000;
        assert_eq!(format_time_remaining(&session, NOW), "1 hour");
    }

    #[test]
    fn test_format_time_minutes() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW + 45 * 60_000;
        assert_eq!(format_time_remaining(&session, NOW), "45 minutes");
    }

    #[test]
    fn test_format_time_expired() {
        let mut session = make_session(0, NOW);
        session.expires_at = NOW - 1000;
        assert_eq!(format_time_remaining(&session, NOW), "expired");
    }

    // ═══ FORMAT EFFORT ═══

    #[test]
    fn test_format_effort_just_started() {
        let session = make_session(30_000, NOW); // 30s
        assert_eq!(format_effort(&session), "just started");
    }

    #[test]
    fn test_format_effort_minutes() {
        let session = make_session(5 * 60_000, NOW);
        assert_eq!(format_effort(&session), "5 minutes");
    }

    #[test]
    fn test_format_effort_one_minute() {
        let session = make_session(60_000, NOW);
        assert_eq!(format_effort(&session), "1 minute");
    }

    #[test]
    fn test_format_effort_hours() {
        let session = make_session(2 * 60 * 60_000, NOW);
        assert_eq!(format_effort(&session), "2 hours");
    }

    #[test]
    fn test_format_effort_one_hour() {
        let session = make_session(60 * 60_000, NOW);
        assert_eq!(format_effort(&session), "1 hour");
    }

    #[test]
    fn test_format_effort_hours_and_minutes() {
        let session = make_session(90 * 60_000, NOW);
        assert_eq!(format_effort(&session), "1h 30m");
    }
}
