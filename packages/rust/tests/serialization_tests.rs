//! Serialization compatibility tests for elizaOS Core
//!
//! These tests verify that Rust types serialize to JSON in a format identical to TypeScript.

use elizaos::types::{
    Agent, AgentStatus, Bio, ChannelType, Character, Content, Memory, Room, State, World, UUID,
};
use pretty_assertions::assert_eq;

/// Test that Memory serializes with camelCase field names
#[test]
fn test_memory_serialization_camelcase() {
    let memory = Memory {
        id: Some(UUID::new("550e8400-e29b-41d4-a716-446655440000").unwrap()),
        entity_id: UUID::new("550e8400-e29b-41d4-a716-446655440001").unwrap(),
        agent_id: Some(UUID::new("550e8400-e29b-41d4-a716-446655440002").unwrap()),
        created_at: Some(1704067200000),
        content: Content {
            text: Some("Hello, world!".to_string()),
            ..Default::default()
        },
        embedding: None,
        room_id: UUID::new("550e8400-e29b-41d4-a716-446655440003").unwrap(),
        world_id: None,
        unique: Some(true),
        similarity: None,
        metadata: None,
    };

    let json = serde_json::to_string(&memory).unwrap();

    // Should use camelCase
    assert!(json.contains("\"entityId\""));
    assert!(json.contains("\"agentId\""));
    assert!(json.contains("\"roomId\""));
    assert!(json.contains("\"createdAt\""));

    // Should not contain snake_case
    assert!(!json.contains("\"entity_id\""));
    assert!(!json.contains("\"agent_id\""));
    assert!(!json.contains("\"room_id\""));
    assert!(!json.contains("\"created_at\""));
}

/// Test that Character deserializes from TypeScript-like JSON
#[test]
fn test_character_deserialization_from_typescript() {
    let ts_json = r#"{
        "name": "TestAgent",
        "bio": "A test agent for testing purposes",
        "username": "test_agent",
        "system": "You are a helpful test agent.",
        "topics": ["testing", "development"],
        "adjectives": ["helpful", "precise"],
        "plugins": ["@elizaos/plugin-sql"]
    }"#;

    let character: Character = serde_json::from_str(ts_json).unwrap();

    assert_eq!(character.name, "TestAgent");
    assert_eq!(character.username, Some("test_agent".to_string()));
    assert_eq!(
        character.system,
        Some("You are a helpful test agent.".to_string())
    );
    assert!(character.topics.is_some());
    assert_eq!(character.topics.as_ref().unwrap().len(), 2);
    assert!(character.plugins.is_some());
    assert_eq!(character.plugins.as_ref().unwrap().len(), 1);
}

/// Test that Character with array bio works
#[test]
fn test_character_array_bio() {
    let ts_json = r#"{
        "name": "TestAgent",
        "bio": ["Line 1 of bio", "Line 2 of bio", "Line 3 of bio"]
    }"#;

    let character: Character = serde_json::from_str(ts_json).unwrap();

    assert_eq!(character.name, "TestAgent");
    match &character.bio {
        Bio::Multiple(lines) => {
            assert_eq!(lines.len(), 3);
            assert_eq!(lines[0], "Line 1 of bio");
        }
        _ => panic!("Expected multiple bio"),
    }
}

/// Test that Agent serializes correctly
#[test]
fn test_agent_serialization() {
    let character = Character {
        id: Some(UUID::new("550e8400-e29b-41d4-a716-446655440000").unwrap()),
        name: "TestAgent".to_string(),
        bio: Bio::Single("Test bio".to_string()),
        ..Default::default()
    };

    let agent = Agent {
        character,
        enabled: Some(true),
        status: Some(AgentStatus::Active),
        created_at: 1704067200000,
        updated_at: 1704067200000,
    };

    let json = serde_json::to_string(&agent).unwrap();

    // Should contain camelCase fields
    assert!(json.contains("\"createdAt\""));
    assert!(json.contains("\"updatedAt\""));
    assert!(json.contains("\"enabled\":true"));
    assert!(json.contains("\"status\":\"active\""));
}

/// Test that Room serializes with correct ChannelType
#[test]
fn test_room_serialization() {
    let room = Room {
        id: UUID::new("550e8400-e29b-41d4-a716-446655440000").unwrap(),
        name: Some("Test Room".to_string()),
        agent_id: None,
        source: "discord".to_string(),
        room_type: ChannelType::Group,
        channel_id: Some("123456".to_string()),
        message_server_id: None,
        world_id: None,
        metadata: None,
    };

    let json = serde_json::to_string(&room).unwrap();

    assert!(json.contains("\"type\":\"GROUP\""));
    assert!(json.contains("\"source\":\"discord\""));
    assert!(json.contains("\"channelId\":\"123456\""));
}

/// Test that World serializes correctly
#[test]
fn test_world_serialization() {
    let world = World {
        id: UUID::new("550e8400-e29b-41d4-a716-446655440000").unwrap(),
        name: Some("Test World".to_string()),
        agent_id: UUID::new("550e8400-e29b-41d4-a716-446655440001").unwrap(),
        message_server_id: None,
        metadata: None,
    };

    let json = serde_json::to_string(&world).unwrap();

    assert!(json.contains("\"name\":\"Test World\""));
    assert!(json.contains("\"agentId\""));
}

/// Test that State serializes correctly
#[test]
fn test_state_serialization() {
    let mut state = State::with_text("Current context");
    state.set_value("key", serde_json::json!("value"));
    state.set_value("number", serde_json::json!(42));
    state.set_value("flag", serde_json::json!(true));

    let json = serde_json::to_string(&state).unwrap();

    assert!(json.contains("\"text\":\"Current context\""));
    assert!(json.contains("\"key\":\"value\""));
    assert!(json.contains("\"number\":42"));
    assert!(json.contains("\"flag\":true"));
}

/// Test that Content with nested fields serializes correctly
#[test]
fn test_content_serialization() {
    let content = Content {
        text: Some("Hello, world!".to_string()),
        thought: Some("Thinking about the response...".to_string()),
        actions: Some(vec!["REPLY".to_string(), "WAIT".to_string()]),
        source: Some("discord".to_string()),
        in_reply_to: Some(UUID::new("550e8400-e29b-41d4-a716-446655440000").unwrap()),
        ..Default::default()
    };

    let json = serde_json::to_string(&content).unwrap();

    assert!(json.contains("\"text\":\"Hello, world!\""));
    assert!(json.contains("\"thought\""));
    assert!(json.contains("\"actions\""));
    assert!(json.contains("\"inReplyTo\""));
}

/// Test UUID roundtrip
#[test]
fn test_uuid_roundtrip() {
    let original = "550e8400-e29b-41d4-a716-446655440000";
    let uuid = UUID::new(original).unwrap();

    let json = serde_json::to_string(&uuid).unwrap();
    let deserialized: UUID = serde_json::from_str(&json).unwrap();

    assert_eq!(uuid, deserialized);
    assert_eq!(deserialized.as_str(), original);
}

/// Test that optional fields are omitted when None
#[test]
fn test_optional_fields_omitted() {
    let memory = Memory {
        id: None,
        entity_id: UUID::new("550e8400-e29b-41d4-a716-446655440001").unwrap(),
        agent_id: None,
        created_at: None,
        content: Content::default(),
        embedding: None,
        room_id: UUID::new("550e8400-e29b-41d4-a716-446655440003").unwrap(),
        world_id: None,
        unique: None,
        similarity: None,
        metadata: None,
    };

    let json = serde_json::to_string(&memory).unwrap();

    // These optional fields should not appear
    assert!(!json.contains("\"id\""));
    assert!(!json.contains("\"agentId\""));
    assert!(!json.contains("\"createdAt\""));
    assert!(!json.contains("\"embedding\""));
    assert!(!json.contains("\"worldId\""));
    assert!(!json.contains("\"similarity\""));
}
