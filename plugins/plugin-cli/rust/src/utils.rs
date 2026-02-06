use std::time::Duration;

/// Default CLI name.
pub const DEFAULT_CLI_NAME: &str = "elizaos";
/// Default CLI version.
pub const DEFAULT_CLI_VERSION: &str = "1.0.0";

/// Parse a duration string into a [`Duration`].
///
/// Supports compound formats and multiple unit suffixes:
///
/// | Input      | Result            |
/// |------------|-------------------|
/// | `"1h"`     | 1 hour            |
/// | `"30m"`    | 30 minutes        |
/// | `"1h30m"`  | 1 hour 30 minutes |
/// | `"2d"`     | 2 days            |
/// | `"90s"`    | 90 seconds        |
/// | `"500ms"`  | 500 milliseconds  |
/// | `"1000"`   | 1000 milliseconds |
///
/// Returns `None` for invalid input.
pub fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }

    // Plain numeric value → milliseconds.
    if let Ok(ms) = s.parse::<u64>() {
        return Some(Duration::from_millis(ms));
    }

    let mut total_ms: u64 = 0;
    let mut found_any = false;
    let mut remaining = s.as_str();

    while !remaining.is_empty() {
        // Skip whitespace.
        remaining = remaining.trim_start();
        if remaining.is_empty() {
            break;
        }

        // Parse leading number (integer or float).
        let num_end = remaining
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(remaining.len());

        if num_end == 0 {
            return None; // Expected a number.
        }

        let num_str = &remaining[..num_end];
        let value: f64 = num_str.parse().ok()?;
        remaining = &remaining[num_end..];

        // Parse unit suffix.
        let unit_end = remaining
            .find(|c: char| c.is_ascii_digit() || c == '.')
            .unwrap_or(remaining.len());

        let unit = remaining[..unit_end].trim();
        remaining = &remaining[unit_end..];

        let multiplier_ms: f64 = match unit {
            "ms" | "millisecond" | "milliseconds" => 1.0,
            "s" | "sec" | "second" | "seconds" => 1_000.0,
            "m" | "min" | "minute" | "minutes" => 60_000.0,
            "h" | "hr" | "hour" | "hours" => 3_600_000.0,
            "d" | "day" | "days" => 86_400_000.0,
            "" if remaining.is_empty() && !found_any => {
                // Bare number with decimal → milliseconds.
                1.0
            }
            _ => return None,
        };

        total_ms = total_ms.saturating_add((value * multiplier_ms).round() as u64);
        found_any = true;
    }

    if found_any {
        Some(Duration::from_millis(total_ms))
    } else {
        None
    }
}

/// Format a [`Duration`] as a human-readable string.
///
/// Uses the largest appropriate unit:
/// - `< 1s` → `"450ms"`
/// - `< 1m` → `"12.3s"`
/// - `< 1h` → `"5.2m"`
/// - `< 1d` → `"3.5h"`
/// - `≥ 1d` → `"2.0d"`
pub fn format_duration(d: Duration) -> String {
    let ms = d.as_millis() as u64;
    if ms < 1_000 {
        format!("{}ms", ms)
    } else if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1_000.0)
    } else if ms < 3_600_000 {
        format!("{:.1}m", ms as f64 / 60_000.0)
    } else if ms < 86_400_000 {
        format!("{:.1}h", ms as f64 / 3_600_000.0)
    } else {
        format!("{:.1}d", ms as f64 / 86_400_000.0)
    }
}

/// Format a byte count as a human-readable string (e.g. `"1.5 MB"`).
///
/// Uses binary prefixes (1 KB = 1024 bytes).
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_idx = 0;

    while value >= 1024.0 && unit_idx < UNITS.len() - 1 {
        value /= 1024.0;
        unit_idx += 1;
    }

    if unit_idx == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", value, UNITS[unit_idx])
    }
}

/// Truncate a string to at most `max_len` characters, appending `"..."` if truncated.
///
/// If the string is shorter than or equal to `max_len`, it is returned unchanged.
pub fn truncate_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else if max_len <= 3 {
        ".".repeat(max_len)
    } else {
        let mut result = String::with_capacity(max_len);
        for (i, c) in s.chars().enumerate() {
            if i >= max_len - 3 {
                break;
            }
            result.push(c);
        }
        result.push_str("...");
        result
    }
}

/// Parse a timeout string with a fallback default.
///
/// If `input` is `None` or parsing fails, returns `default_ms`.
pub fn parse_timeout_ms(input: Option<&str>, default_ms: u64) -> u64 {
    match input {
        Some(s) => parse_duration(s).map_or(default_ms, |d| d.as_millis() as u64),
        None => default_ms,
    }
}

/// Format a CLI command string with optional profile and env context.
pub fn format_cli_command(command: &str, cli_name: Option<&str>, profile: Option<&str>, env: Option<&str>) -> String {
    let mut parts = vec![cli_name.unwrap_or(DEFAULT_CLI_NAME).to_string()];

    if let Some(p) = profile {
        parts.push(format!("--profile {}", p));
    }

    if let Some(e) = env {
        parts.push(format!("--env {}", e));
    }

    parts.push(command.to_string());
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_duration_basic_units() {
        assert_eq!(parse_duration("1s"), Some(Duration::from_secs(1)));
        assert_eq!(parse_duration("30m"), Some(Duration::from_secs(30 * 60)));
        assert_eq!(parse_duration("1h"), Some(Duration::from_secs(3600)));
        assert_eq!(parse_duration("2d"), Some(Duration::from_secs(2 * 86400)));
        assert_eq!(parse_duration("500ms"), Some(Duration::from_millis(500)));
    }

    #[test]
    fn test_parse_duration_plain_number() {
        assert_eq!(parse_duration("1000"), Some(Duration::from_millis(1000)));
    }

    #[test]
    fn test_format_bytes_units() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
    }
}
