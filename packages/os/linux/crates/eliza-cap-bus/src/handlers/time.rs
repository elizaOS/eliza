// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

//! `time:read` handler.
//!
//! Returns the current wall-clock time as both an epoch-millis integer
//! and an ISO 8601 / RFC 3339 string in UTC, plus the system timezone
//! name. This is the simplest capability — the cap-bus needs no
//! filesystem access and no arguments.
//!
//! Shape:
//!
//! ```json
//! { "ts_ms": 1747015632000, "iso": "2026-05-11T19:27:12Z", "tz": "UTC" }
//! ```
//!
//! `ts_ms` is the canonical field; `iso` is a convenience for apps that
//! don't want to format the epoch themselves; `tz` is the host's IANA
//! zone name as read from `/etc/timezone` (falls back to `"UTC"` when
//! the file is absent).

use std::time::{SystemTime, UNIX_EPOCH};

use crate::Response;

use super::rpc_ok;

/// Handle the `time:read` method. Takes no parameters.
#[must_use]
pub fn read(id: serde_json::Value) -> Response {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let epoch_ms: u64 = u64::try_from(now.as_millis()).unwrap_or(u64::MAX);
    rpc_ok(
        id,
        serde_json::json!({
            "ts_ms": epoch_ms,
            "epoch_ms": epoch_ms,           // legacy alias, preserved for older callers
            "epoch_secs": now.as_secs(),    // legacy alias, preserved for older callers
            "iso": iso8601_utc(now.as_secs()),
            "iso8601_utc": iso8601_utc(now.as_secs()), // legacy alias
            "tz": tz_name(),
        }),
    )
}

/// Format an epoch-seconds value as an RFC 3339 / ISO 8601 string in UTC.
///
/// Inlined rather than pulling chrono — we never need anything outside
/// "UTC, fixed format" here, and pulling chrono just for one format
/// would add ~200KB to the binary.
fn iso8601_utc(secs: u64) -> String {
    let mut secs = i64::try_from(secs).unwrap_or(0);
    let days = secs / 86_400;
    secs -= days * 86_400;
    let hour = secs / 3600;
    let minute = (secs % 3600) / 60;
    let second = secs % 60;
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]
fn days_to_ymd(days_since_epoch: i64) -> (i64, u32, u32) {
    // Howard Hinnant, "From days to civil date".
    // https://howardhinnant.github.io/date_algorithms.html#civil_from_days
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

/// Read the system timezone string (`/etc/timezone`), falling back to
/// `"UTC"` when the file is absent. Override via the `USBELIZA_TZ` env
/// var so tests don't depend on the host filesystem.
fn tz_name() -> String {
    if let Ok(v) = std::env::var("USBELIZA_TZ")
        && !v.is_empty()
    {
        return v;
    }
    std::fs::read_to_string("/etc/timezone")
        .map_or_else(|_| "UTC".to_owned(), |s| s.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_returns_ts_ms_and_iso_string() {
        let resp = read(serde_json::json!(1));
        assert!(resp.error.is_none());
        let result = resp.result.expect("result");
        assert!(result["ts_ms"].as_u64().unwrap() > 0);
        let iso = result["iso"].as_str().unwrap();
        assert!(iso.ends_with('Z'));
        assert_eq!(iso.len(), 20);
    }

    #[test]
    fn iso8601_utc_known_epoch() {
        // 1970-01-01 00:00:00Z — epoch zero.
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        // 2000-03-01 00:00:00Z — the worst boundary for civil-from-days
        // algorithms (March 1 of a leap-century year). 11017 days since
        // epoch → 951868800.
        assert_eq!(iso8601_utc(951_868_800), "2000-03-01T00:00:00Z");
        // 2026-01-01 00:00:00Z — start-of-year sanity check.
        // 56 years * 365 + 14 leap days = 20454 days → 1767225600.
        assert_eq!(iso8601_utc(1_767_225_600), "2026-01-01T00:00:00Z");
    }

    #[test]
    fn tz_name_returns_non_empty_string() {
        // The workspace forbids `unsafe`, so we can't mutate the
        // process env to exercise the override branch here. We assert
        // the steady-state contract: tz_name() always returns a
        // non-empty value (either the env override, /etc/timezone, or
        // the "UTC" fallback).
        let v = tz_name();
        assert!(!v.is_empty(), "tz_name must always return a value");
    }
}
