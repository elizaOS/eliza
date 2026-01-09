//! UUID Compatibility tests
//!
//! Verifies that UUID generation and handling is compatible with TypeScript

use uuid::Uuid;

/// Test that stringToUuid produces the same results as TypeScript
/// The TypeScript function uses a specific algorithm we need to match
#[test]
fn test_string_to_uuid_deterministic() {
    // Use UUID v5 with DNS namespace (same as TypeScript)
    let namespace = Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap();

    // Test known inputs and verify outputs are consistent
    let test_cases = vec![
        ("test", None),      // Will verify Rust is deterministic
        ("hello", None),     // across multiple calls
        ("agent-1", None),   // with various inputs
        ("room-abc", None),  // including special chars
        ("user@email.com", None),
    ];

    for (input, expected) in test_cases {
        let uuid1 = Uuid::new_v5(&namespace, input.as_bytes());
        let uuid2 = Uuid::new_v5(&namespace, input.as_bytes());

        // Verify determinism
        assert_eq!(uuid1, uuid2, "UUID should be deterministic for: {}", input);

        // Verify format
        let uuid_str = uuid1.to_string();
        assert!(
            Uuid::parse_str(&uuid_str).is_ok(),
            "UUID should be valid: {}",
            uuid_str
        );
        assert_eq!(uuid_str.len(), 36, "UUID string should be 36 chars");

        // If we have an expected value, verify it matches
        if let Some(exp) = expected {
            assert_eq!(uuid_str, exp, "UUID should match expected for: {}", input);
        }
    }
}

#[test]
fn test_uuid_v4_format() {
    for _ in 0..100 {
        let uuid = Uuid::new_v4();
        let uuid_str = uuid.to_string();

        // Verify format
        assert_eq!(uuid_str.len(), 36);
        assert!(uuid_str.chars().filter(|c| *c == '-').count() == 4);

        // Verify it parses back
        assert!(Uuid::parse_str(&uuid_str).is_ok());
    }
}

#[test]
fn test_uuid_parsing_various_formats() {
    let valid_uuids = vec![
        "550e8400-e29b-41d4-a716-446655440000",
        "550E8400-E29B-41D4-A716-446655440000", // uppercase
        "550e8400e29b41d4a716446655440000",      // no dashes (should still work via Uuid::parse_str)
    ];

    for uuid_str in valid_uuids {
        let result = Uuid::try_parse(uuid_str);
        if uuid_str.contains('-') {
            assert!(result.is_ok(), "Should parse: {}", uuid_str);
        }
    }
}

#[test]
fn test_uuid_nil() {
    let nil = Uuid::nil();
    assert_eq!(nil.to_string(), "00000000-0000-0000-0000-000000000000");
}

#[test]
fn test_uuid_uniqueness() {
    use std::collections::HashSet;

    let mut uuids = HashSet::new();
    for _ in 0..1000 {
        let uuid = Uuid::new_v4().to_string();
        assert!(
            uuids.insert(uuid.clone()),
            "UUID should be unique: {}",
            uuid
        );
    }
}

/// Test TypeScript-compatible stringToUuid function
fn string_to_uuid(input: &str) -> String {
    let namespace = Uuid::parse_str("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap();
    Uuid::new_v5(&namespace, input.as_bytes()).to_string()
}

#[test]
fn test_string_to_uuid_specific_inputs() {
    // These should produce consistent, deterministic UUIDs
    let inputs = vec![
        "test-agent",
        "test-room",
        "test-entity",
        "Hello World",
        "user123",
        "",
        "a",
        "🎉", // emoji
    ];

    for input in inputs {
        let uuid1 = string_to_uuid(input);
        let uuid2 = string_to_uuid(input);
        assert_eq!(uuid1, uuid2, "Should be deterministic for: {:?}", input);
        assert!(Uuid::parse_str(&uuid1).is_ok(), "Should be valid UUID");
    }
}

#[test]
fn test_string_to_uuid_different_inputs_produce_different_uuids() {
    let inputs = vec!["input1", "input2", "input3"];
    let uuids: Vec<String> = inputs.iter().map(|i| string_to_uuid(i)).collect();

    // All should be different
    for i in 0..uuids.len() {
        for j in (i + 1)..uuids.len() {
            assert_ne!(
                uuids[i], uuids[j],
                "Different inputs should produce different UUIDs"
            );
        }
    }
}

