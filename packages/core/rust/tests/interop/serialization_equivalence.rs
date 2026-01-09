//! Serialization equivalence tests
//!
//! These tests verify that Rust serialization produces identical JSON
//! to the TypeScript implementation.

use elizaos::types::{
    character::{Agent, AgentStatus, Bio, Character},
    environment::{ChannelType, Component, Entity, Relationship, Role, Room, World},
    memory::{Memory, MemoryMetadata, MemoryType},
    primitives::Content,
    state::{Goal, State, Task, TaskStatus},
};
use serde_json::{json, Value};

/// Test fixtures that match TypeScript output exactly
mod fixtures {
    use super::*;

    pub fn basic_memory_json() -> Value {
        json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "entityId": "550e8400-e29b-41d4-a716-446655440001",
            "roomId": "550e8400-e29b-41d4-a716-446655440002",
            "content": {
                "text": "Hello, world!",
                "source": "test"
            },
            "createdAt": 1704067200000_i64
        })
    }

    pub fn full_character_json() -> Value {
        json!({
            "name": "TestAgent",
            "system": "You are a helpful assistant.",
            "bio": ["An AI assistant", "Helps users with tasks"],
            "topics": ["general", "coding", "writing"],
            "messageExamples": [
                [
                    {"name": "user", "content": {"text": "Hello"}},
                    {"name": "TestAgent", "content": {"text": "Hi there!"}}
                ]
            ],
            "postExamples": ["Check out this cool thing!"],
            "settings": {
                "model": "gpt-4",
                "temperature": 0.7
            }
        })
    }

    pub fn agent_json() -> Value {
        json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "TestAgent",
            "bio": "A test agent for verification",
            "status": "active",
            "enabled": true
        })
    }

    pub fn room_json() -> Value {
        json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "name": "Test Room",
            "source": "test",
            "type": "GROUP",
            "channelId": "channel-123",
            "serverId": "server-456",
            "worldId": "550e8400-e29b-41d4-a716-446655440001"
        })
    }

    pub fn entity_json() -> Value {
        json!({
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "names": ["User", "TestUser"],
            "agentId": "550e8400-e29b-41d4-a716-446655440001",
            "metadata": {
                "email": "test@example.com"
            }
        })
    }
}

#[test]
fn test_memory_serialization_matches_typescript() {
    let memory = Memory {
        id: Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
        entity_id: "550e8400-e29b-41d4-a716-446655440001".to_string(),
        room_id: "550e8400-e29b-41d4-a716-446655440002".to_string(),
        content: Content {
            text: Some("Hello, world!".to_string()),
            source: Some("test".to_string()),
            ..Default::default()
        },
        created_at: Some(1704067200000),
        ..Default::default()
    };

    let serialized = serde_json::to_value(&memory).unwrap();
    let expected = fixtures::basic_memory_json();

    // Check key fields match
    assert_eq!(serialized["id"], expected["id"]);
    assert_eq!(serialized["entityId"], expected["entityId"]);
    assert_eq!(serialized["roomId"], expected["roomId"]);
    assert_eq!(serialized["content"]["text"], expected["content"]["text"]);
    assert_eq!(
        serialized["content"]["source"],
        expected["content"]["source"]
    );
    assert_eq!(serialized["createdAt"], expected["createdAt"]);
}

#[test]
fn test_memory_deserialization_from_typescript() {
    let typescript_json = fixtures::basic_memory_json();
    let memory: Memory = serde_json::from_value(typescript_json).unwrap();

    assert_eq!(
        memory.id,
        Some("550e8400-e29b-41d4-a716-446655440000".to_string())
    );
    assert_eq!(
        memory.entity_id,
        "550e8400-e29b-41d4-a716-446655440001".to_string()
    );
    assert_eq!(
        memory.room_id,
        "550e8400-e29b-41d4-a716-446655440002".to_string()
    );
    assert_eq!(memory.content.text, Some("Hello, world!".to_string()));
    assert_eq!(memory.content.source, Some("test".to_string()));
    assert_eq!(memory.created_at, Some(1704067200000));
}

#[test]
fn test_memory_round_trip() {
    let original = fixtures::basic_memory_json();
    let memory: Memory = serde_json::from_value(original.clone()).unwrap();
    let serialized = serde_json::to_value(&memory).unwrap();
    let reparsed: Memory = serde_json::from_value(serialized.clone()).unwrap();
    let reserialized = serde_json::to_value(&reparsed).unwrap();

    // Check that round-trip produces identical results
    assert_eq!(serialized, reserialized);
}

#[test]
fn test_character_serialization_matches_typescript() {
    let character = Character {
        name: "TestAgent".to_string(),
        system: Some("You are a helpful assistant.".to_string()),
        bio: Some(Bio::Multiple(vec![
            "An AI assistant".to_string(),
            "Helps users with tasks".to_string(),
        ])),
        topics: Some(vec![
            "general".to_string(),
            "coding".to_string(),
            "writing".to_string(),
        ]),
        ..Default::default()
    };

    let serialized = serde_json::to_value(&character).unwrap();

    assert_eq!(serialized["name"], "TestAgent");
    assert_eq!(serialized["system"], "You are a helpful assistant.");
}

#[test]
fn test_character_deserialization_from_typescript() {
    let typescript_json = fixtures::full_character_json();
    let character: Character = serde_json::from_value(typescript_json).unwrap();

    assert_eq!(character.name, "TestAgent");
    assert_eq!(
        character.system,
        Some("You are a helpful assistant.".to_string())
    );
    assert!(character.topics.is_some());
    let topics = character.topics.unwrap();
    assert_eq!(topics.len(), 3);
    assert!(topics.contains(&"general".to_string()));
}

#[test]
fn test_agent_serialization_matches_typescript() {
    let agent = Agent {
        id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
        name: "TestAgent".to_string(),
        bio: Some(Bio::Single("A test agent for verification".to_string())),
        status: Some(AgentStatus::Active),
        enabled: Some(true),
        ..Default::default()
    };

    let serialized = serde_json::to_value(&agent).unwrap();
    let expected = fixtures::agent_json();

    assert_eq!(serialized["id"], expected["id"]);
    assert_eq!(serialized["name"], expected["name"]);
    assert_eq!(serialized["status"], expected["status"]);
    assert_eq!(serialized["enabled"], expected["enabled"]);
}

#[test]
fn test_agent_deserialization_from_typescript() {
    let typescript_json = fixtures::agent_json();
    let agent: Agent = serde_json::from_value(typescript_json).unwrap();

    assert_eq!(agent.id, "550e8400-e29b-41d4-a716-446655440000".to_string());
    assert_eq!(agent.name, "TestAgent".to_string());
    assert_eq!(agent.status, Some(AgentStatus::Active));
    assert_eq!(agent.enabled, Some(true));
}

#[test]
fn test_room_serialization_matches_typescript() {
    let room = Room {
        id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
        name: Some("Test Room".to_string()),
        source: Some("test".to_string()),
        room_type: Some(ChannelType::Group),
        channel_id: Some("channel-123".to_string()),
        server_id: Some("server-456".to_string()),
        world_id: Some("550e8400-e29b-41d4-a716-446655440001".to_string()),
        ..Default::default()
    };

    let serialized = serde_json::to_value(&room).unwrap();
    let expected = fixtures::room_json();

    assert_eq!(serialized["id"], expected["id"]);
    assert_eq!(serialized["name"], expected["name"]);
}

#[test]
fn test_room_deserialization_from_typescript() {
    let typescript_json = fixtures::room_json();
    let room: Room = serde_json::from_value(typescript_json).unwrap();

    assert_eq!(room.id, "550e8400-e29b-41d4-a716-446655440000".to_string());
    assert_eq!(room.name, Some("Test Room".to_string()));
    assert_eq!(room.room_type, Some(ChannelType::Group));
}

#[test]
fn test_entity_serialization_matches_typescript() {
    let entity = Entity {
        id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
        names: Some(vec!["User".to_string(), "TestUser".to_string()]),
        agent_id: Some("550e8400-e29b-41d4-a716-446655440001".to_string()),
        metadata: Some(serde_json::json!({"email": "test@example.com"})),
        ..Default::default()
    };

    let serialized = serde_json::to_value(&entity).unwrap();
    let expected = fixtures::entity_json();

    assert_eq!(serialized["id"], expected["id"]);
    assert_eq!(serialized["names"], expected["names"]);
    assert_eq!(serialized["metadata"]["email"], expected["metadata"]["email"]);
}

#[test]
fn test_entity_deserialization_from_typescript() {
    let typescript_json = fixtures::entity_json();
    let entity: Entity = serde_json::from_value(typescript_json).unwrap();

    assert_eq!(
        entity.id,
        "550e8400-e29b-41d4-a716-446655440000".to_string()
    );
    assert_eq!(
        entity.names,
        Some(vec!["User".to_string(), "TestUser".to_string()])
    );
}

#[test]
fn test_channel_type_serialization() {
    // Test all channel types serialize correctly
    let types = vec![
        (ChannelType::Dm, "DM"),
        (ChannelType::Group, "GROUP"),
        (ChannelType::Voice, "VOICE"),
        (ChannelType::Feed, "FEED"),
        (ChannelType::Thread, "THREAD"),
        (ChannelType::World, "WORLD"),
        (ChannelType::Self_, "SELF"),
        (ChannelType::Api, "API"),
    ];

    for (channel_type, expected) in types {
        let serialized = serde_json::to_value(&channel_type).unwrap();
        assert_eq!(serialized, expected);
    }
}

#[test]
fn test_agent_status_serialization() {
    let statuses = vec![
        (AgentStatus::Active, "active"),
        (AgentStatus::Inactive, "inactive"),
        (AgentStatus::Paused, "paused"),
    ];

    for (status, expected) in statuses {
        let serialized = serde_json::to_value(&status).unwrap();
        assert_eq!(serialized, expected);
    }
}

#[test]
fn test_task_status_serialization() {
    let statuses = vec![
        (TaskStatus::Pending, "pending"),
        (TaskStatus::InProgress, "in_progress"),
        (TaskStatus::Completed, "completed"),
        (TaskStatus::Failed, "failed"),
        (TaskStatus::Cancelled, "cancelled"),
    ];

    for (status, expected) in statuses {
        let serialized = serde_json::to_value(&status).unwrap();
        assert_eq!(serialized, expected);
    }
}

#[test]
fn test_memory_type_serialization() {
    let types = vec![
        (MemoryType::Message, "message"),
        (MemoryType::Document, "document"),
        (MemoryType::Post, "post"),
        (MemoryType::Custom("custom".to_string()), "custom"),
    ];

    for (memory_type, expected) in types {
        let serialized = serde_json::to_value(&memory_type).unwrap();
        assert_eq!(serialized, expected);
    }
}

