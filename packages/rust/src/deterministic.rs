//! Deterministic helpers for prompt-cache-friendly context generation.
//!
//! This module mirrors deterministic helpers from TypeScript/Python so Rust
//! prompt construction can stay stable for a given conversation surface.

use sha2::{Digest, Sha256};

use crate::types::memory::Memory;
use crate::types::state::State;

/// Default deterministic time bucket (5 minutes).
pub const DEFAULT_TIME_BUCKET_MS: i64 = 5 * 60 * 1000;

/// Builds a deterministic seed string by joining normalized parts with `|`.
pub fn build_deterministic_seed(parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| {
            if part.is_empty() {
                "none"
            } else {
                part.as_str()
            }
        })
        .collect::<Vec<&str>>()
        .join("|")
}

/// Returns a deterministic hex string for a seed/surface pair.
pub fn deterministic_hex(seed: &str, surface: &str, length: usize) -> String {
    if length == 0 {
        return String::new();
    }

    let mut out = String::new();
    let mut counter: u64 = 0;
    while out.len() < length {
        let mut hasher = Sha256::new();
        hasher.update(seed.as_bytes());
        hasher.update(b"|");
        hasher.update(surface.as_bytes());
        hasher.update(b"|");
        hasher.update(counter.to_string().as_bytes());
        let digest = hasher.finalize();
        out.push_str(&hex::encode(digest));
        counter = counter.saturating_add(1);
    }
    out[..length].to_string()
}

/// Returns a deterministic integer in the range `[0, max_exclusive)`.
pub fn deterministic_int(seed: &str, surface: &str, max_exclusive: usize) -> usize {
    if max_exclusive <= 1 {
        return 0;
    }

    let hex = deterministic_hex(seed, surface, 12);
    let value = u64::from_str_radix(&hex, 16).unwrap_or(0);
    (value as usize) % max_exclusive
}

/// Returns a deterministic UUID-like string from seed/surface.
pub fn deterministic_uuid(seed: &str, surface: &str) -> String {
    let hex = deterministic_hex(seed, surface, 32);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Parse a boolean setting from text.
pub fn parse_boolean_setting(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return false;
    };
    let normalized = raw.trim().to_lowercase();
    matches!(normalized.as_str(), "1" | "true" | "yes" | "on" | "enabled")
}

/// Parse a positive integer setting from text.
pub fn parse_positive_integer_setting(value: Option<&str>, fallback: i64) -> i64 {
    let Some(raw) = value else {
        return fallback;
    };
    let normalized = raw.trim();
    if normalized.is_empty() {
        return fallback;
    }

    match normalized.parse::<f64>() {
        Ok(parsed) if parsed.is_finite() && parsed > 0.0 => parsed.floor() as i64,
        _ => fallback,
    }
}

/// Builds a deterministic conversation seed using world/room/character IDs.
pub fn build_conversation_seed(
    agent_id: &(impl ToString + ?Sized),
    character_id: Option<&(impl ToString + ?Sized)>,
    message: Option<&Memory>,
    state: Option<&State>,
    surface: &str,
    bucket_ms: Option<i64>,
    now_ms: i64,
) -> String {
    let state_room_id = state
        .and_then(|s| s.data.as_ref())
        .and_then(|d| d.room.as_ref())
        .map(|room| room.id.trim())
        .filter(|id| !id.is_empty());

    let state_world_id = state
        .and_then(|s| s.data.as_ref())
        .and_then(|d| d.world.as_ref())
        .map(|world| world.id.trim())
        .filter(|id| !id.is_empty())
        .or_else(|| {
            state
                .and_then(|s| s.data.as_ref())
                .and_then(|d| d.room.as_ref())
                .and_then(|room| room.world_id.as_deref())
                .map(str::trim)
                .filter(|id| !id.is_empty())
        });

    let message_room_id = message
        .map(|m| m.room_id.as_str().trim())
        .filter(|id| !id.is_empty());

    let message_world_id = message
        .and_then(|m| m.world_id.as_ref())
        .map(|world| world.as_str().trim())
        .filter(|id| !id.is_empty());

    let room_id = state_room_id.or(message_room_id).unwrap_or("room:none");
    let world_id = state_world_id.or(message_world_id).unwrap_or("world:none");
    let selected_character_id = character_id
        .map(ToString::to_string)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| agent_id.to_string());

    let epoch_bucket = match bucket_ms {
        Some(ms) if ms > 0 => now_ms.div_euclid(ms),
        _ => 0,
    };

    build_deterministic_seed(&[
        "eliza-prompt-cache-v1".to_string(),
        world_id.to_string(),
        room_id.to_string(),
        selected_character_id,
        epoch_bucket.to_string(),
        surface.to_string(),
    ])
}

/// Returns a deterministic reference timestamp for prompt-time context.
pub fn get_prompt_reference_timestamp_ms(
    deterministic_enabled: bool,
    bucket_ms: i64,
    seed: &str,
    now_ms: i64,
) -> i64 {
    if !deterministic_enabled {
        return now_ms;
    }

    let effective_bucket_ms = if bucket_ms > 0 {
        bucket_ms
    } else {
        DEFAULT_TIME_BUCKET_MS
    };
    let bucket_start = now_ms.div_euclid(effective_bucket_ms) * effective_bucket_ms;
    let max_exclusive = usize::try_from(effective_bucket_ms).unwrap_or(0);
    let offset = deterministic_int(seed, "time-offset-ms", max_exclusive) as i64;
    bucket_start + offset
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::primitives::as_uuid;

    #[test]
    fn deterministic_hex_is_stable() {
        let first = deterministic_hex("seed", "surface", 16);
        let second = deterministic_hex("seed", "surface", 16);
        assert_eq!(first, second);
        assert_eq!(first.len(), 16);
    }

    #[test]
    fn deterministic_int_is_in_range() {
        let value = deterministic_int("seed", "surface", 7);
        assert!(value < 7);
    }

    #[test]
    fn deterministic_uuid_is_stable() {
        let first = deterministic_uuid("seed", "surface");
        let second = deterministic_uuid("seed", "surface");
        assert_eq!(first, second);
        assert_eq!(first.len(), 36);
    }

    #[test]
    fn parse_boolean_setting_truthy() {
        assert!(parse_boolean_setting(Some("true")));
        assert!(parse_boolean_setting(Some("1")));
        assert!(parse_boolean_setting(Some("enabled")));
        assert!(!parse_boolean_setting(Some("false")));
    }

    #[test]
    fn parse_positive_integer_setting_valid() {
        assert_eq!(parse_positive_integer_setting(Some("5000"), 100), 5000);
        assert_eq!(parse_positive_integer_setting(Some("5000.9"), 100), 5000);
        assert_eq!(parse_positive_integer_setting(Some("0"), 100), 100);
    }

    #[test]
    fn conversation_seed_contains_core_dimensions() {
        let agent_id = as_uuid("11111111-1111-1111-1111-111111111111").expect("valid uuid");
        let seed = build_conversation_seed(
            &agent_id,
            None::<&str>,
            None,
            None,
            "surface",
            Some(1000),
            2500,
        );
        assert!(seed.contains("eliza-prompt-cache-v1"));
        assert!(seed.contains("world:none"));
        assert!(seed.contains("room:none"));
        assert!(seed.contains("2"));
    }

    #[test]
    fn prompt_reference_timestamp_respects_bucket() {
        let now_ms = 1_750_000_123_456i64;
        let bucket_ms = 300_000i64;
        let seed = "seed";
        let result = get_prompt_reference_timestamp_ms(true, bucket_ms, seed, now_ms);
        let bucket_start = now_ms.div_euclid(bucket_ms) * bucket_ms;
        assert!(result >= bucket_start);
        assert!(result < bucket_start + bucket_ms);
    }
}
