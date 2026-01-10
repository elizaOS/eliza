//! UUID Compatibility tests
//!
//! Verifies that UUID generation and handling is compatible with TypeScript

use elizaos::types::{string_to_uuid, UUID};
use uuid::Uuid;

/// Test that stringToUuid produces the same results as TypeScript
/// The TypeScript function uses a specific algorithm we need to match
#[test]
fn test_string_to_uuid_deterministic() {
    // These are the canonical TypeScript test vectors from
    // `packages/typescript/typescript/src/__tests__/utils/stringToUuid.test.ts`.
    let test_cases = vec![
        ("test", "a94a8fe5-ccb1-0ba6-9c4c-0873d391e987"),
        ("hello world", "f0355dd5-2823-054c-ae66-a0b12842c215"),
        ("", "da39a3ee-5e6b-0b0d-b255-bfef95601890"),
        ("123", "40bd0015-6308-0fc3-9165-329ea1ff5c5e"),
        ("user:agent", "a49810ce-da30-0d3b-97ee-d4d47774d8af"),
    ];

    for (input, expected) in test_cases {
        let uuid1 = string_to_uuid(input);
        let uuid2 = string_to_uuid(input);

        // Verify determinism
        assert_eq!(uuid1.as_str(), uuid2.as_str(), "UUID should be deterministic");
        assert_eq!(uuid1.as_str(), expected);

        // Verify format via our UUID wrapper (TypeScript uses regex validation)
        assert!(UUID::new(uuid1.as_str()).is_ok());
        assert_eq!(uuid1.as_str().len(), 36, "UUID string should be 36 chars");
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
        assert_eq!(
            uuid1.as_str(),
            uuid2.as_str(),
            "Should be deterministic for: {:?}",
            input
        );
        assert!(UUID::new(uuid1.as_str()).is_ok(), "Should be valid UUID");
    }
}

#[test]
fn test_string_to_uuid_different_inputs_produce_different_uuids() {
    let inputs = vec!["input1", "input2", "input3"];
    let uuids: Vec<String> = inputs
        .iter()
        .map(|i| string_to_uuid(i).to_string())
        .collect();

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

