use anyhow::{anyhow, Result};

/// Parse human-readable duration strings into milliseconds
/// Supports formats like: "1s", "500ms", "2m", "1.5s", "30", "2h"
pub fn parse_duration(input: &str) -> Result<u64> {
    let input = input.trim();

    // Try to parse as plain number first (assumes milliseconds)
    if let Ok(ms) = input.parse::<u64>() {
        return Ok(ms);
    }

    // Parse with units
    let (number_part, unit_part) = split_number_and_unit(input)?;
    let value: f64 = number_part
        .parse()
        .map_err(|_| anyhow!("Invalid number in duration: {}", number_part))?;

    let multiplier = match unit_part {
        "ms" | "milliseconds" | "millisecond" => 1.0,
        "s" | "sec" | "secs" | "second" | "seconds" => 1000.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000.0,
        "" => 1.0, // Default to milliseconds if no unit
        _ => return Err(anyhow!("Unknown time unit: {}", unit_part)),
    };

    Ok((value * multiplier) as u64)
}

fn split_number_and_unit(input: &str) -> Result<(&str, &str)> {
    // Find where the numeric part ends
    let mut split_pos = input.len();
    for (i, ch) in input.char_indices() {
        if ch.is_alphabetic() {
            split_pos = i;
            break;
        }
    }

    let number_part = &input[..split_pos];
    let unit_part = &input[split_pos..];

    if number_part.is_empty() {
        return Err(anyhow!("No numeric value in duration: {}", input));
    }

    Ok((number_part, unit_part))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_duration_milliseconds() {
        assert_eq!(parse_duration("500").unwrap(), 500);
        assert_eq!(parse_duration("1000ms").unwrap(), 1000);
        assert_eq!(parse_duration("250milliseconds").unwrap(), 250);
    }

    #[test]
    fn test_parse_duration_seconds() {
        assert_eq!(parse_duration("1s").unwrap(), 1000);
        assert_eq!(parse_duration("2.5s").unwrap(), 2500);
        assert_eq!(parse_duration("10seconds").unwrap(), 10000);
    }

    #[test]
    fn test_parse_duration_minutes() {
        assert_eq!(parse_duration("1m").unwrap(), 60000);
        assert_eq!(parse_duration("2min").unwrap(), 120000);
        assert_eq!(parse_duration("0.5minutes").unwrap(), 30000);
    }

    #[test]
    fn test_parse_duration_hours() {
        assert_eq!(parse_duration("1h").unwrap(), 3600000);
        assert_eq!(parse_duration("2hours").unwrap(), 7200000);
        assert_eq!(parse_duration("0.5h").unwrap(), 1800000);
    }

    #[test]
    fn test_parse_duration_errors() {
        assert!(parse_duration("abc").is_err());
        assert!(parse_duration("10x").is_err());
        assert!(parse_duration("").is_err());
    }
}
