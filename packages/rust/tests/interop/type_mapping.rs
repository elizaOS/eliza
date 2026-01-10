//! Type mapping tests
//!
//! Verifies that Rust types map correctly to TypeScript types

use elizaos::types::{
    character::{Agent, AgentStatus, Bio, Character},
    components::{Action, Evaluator, Provider},
    environment::{ChannelType, Component, Entity, Relationship, Room, World},
    events::EventType,
    memory::{Memory, MemoryMetadata, MemoryType},
    model::ModelType,
    plugin::Plugin,
    primitives::Content,
    state::{Goal, State, Task, TaskStatus},
};
use serde_json::Value;

/// Test that optional fields are properly handled
#[test]
fn test_optional_fields_serialize_correctly() {
    // Memory with only required fields
    let minimal_memory = Memory {
        entity_id: "entity-123".to_string(),
        room_id: "room-456".to_string(),
        content: Content::default(),
        ..Default::default()
    };

    let json = serde_json::to_value(&minimal_memory).unwrap();

    // Required fields should be present
    assert!(json.get("entityId").is_some());
    assert!(json.get("roomId").is_some());
    assert!(json.get("content").is_some());

    // Optional fields should be absent or null
    assert!(json.get("id").is_none() || json.get("id").unwrap().is_null());
}

/// Test that arrays are properly handled
#[test]
fn test_array_fields() {
    let character = Character {
        name: "Test".to_string(),
        topics: Some(vec!["topic1".to_string(), "topic2".to_string()]),
        bio: Some(Bio::Multiple(vec!["bio1".to_string(), "bio2".to_string()])),
        ..Default::default()
    };

    let json = serde_json::to_value(&character).unwrap();

    assert!(json["topics"].is_array());
    assert_eq!(json["topics"].as_array().unwrap().len(), 2);
}

/// Test that nested objects are properly serialized
#[test]
fn test_nested_object_serialization() {
    let memory = Memory {
        entity_id: "entity-123".to_string(),
        room_id: "room-456".to_string(),
        content: Content {
            text: Some("Hello".to_string()),
            source: Some("test".to_string()),
            metadata: Some(serde_json::json!({"key": "value"})),
            ..Default::default()
        },
        ..Default::default()
    };

    let json = serde_json::to_value(&memory).unwrap();

    assert!(json["content"].is_object());
    assert_eq!(json["content"]["text"], "Hello");
    assert_eq!(json["content"]["source"], "test");
    assert!(json["content"]["metadata"].is_object());
}

/// Test enum serialization strategies
#[test]
fn test_enum_serialization() {
    // String enums (lowercase)
    let agent_status = AgentStatus::Active;
    assert_eq!(serde_json::to_value(&agent_status).unwrap(), "active");

    // String enums (snake_case)
    let task_status = TaskStatus::InProgress;
    assert_eq!(serde_json::to_value(&task_status).unwrap(), "in_progress");

    // String enums (UPPER)
    let channel_type = ChannelType::Group;
    assert_eq!(serde_json::to_value(&channel_type).unwrap(), "GROUP");
}

/// Test that Bio can be either string or array
#[test]
fn test_bio_union_type() {
    // Single string bio
    let single_bio = Bio::Single("A simple bio".to_string());
    let json = serde_json::to_value(&single_bio).unwrap();
    assert!(json.is_string());
    assert_eq!(json.as_str().unwrap(), "A simple bio");

    // Array bio
    let multi_bio = Bio::Multiple(vec!["Line 1".to_string(), "Line 2".to_string()]);
    let json = serde_json::to_value(&multi_bio).unwrap();
    assert!(json.is_array());
    assert_eq!(json.as_array().unwrap().len(), 2);
}

/// Test that Content handles all field types correctly
#[test]
fn test_content_all_fields() {
    let content = Content {
        text: Some("Hello".to_string()),
        source: Some("test".to_string()),
        url: Some("https://example.com".to_string()),
        actions: Some(vec!["action1".to_string(), "action2".to_string()]),
        metadata: Some(serde_json::json!({"nested": {"key": "value"}})),
        attachments: Some(vec![serde_json::json!({"type": "image", "url": "..."})]),
        ..Default::default()
    };

    let json = serde_json::to_value(&content).unwrap();

    assert_eq!(json["text"], "Hello");
    assert_eq!(json["source"], "test");
    assert_eq!(json["url"], "https://example.com");
    assert!(json["actions"].is_array());
    assert!(json["metadata"].is_object());
    assert!(json["attachments"].is_array());
}

/// Test Plugin structure
#[test]
fn test_plugin_structure() {
    let plugin = Plugin {
        name: "test-plugin".to_string(),
        description: Some("A test plugin".to_string()),
        actions: Some(vec![]),
        evaluators: Some(vec![]),
        providers: Some(vec![]),
        services: Some(vec![]),
        dependencies: Some(vec!["dep1".to_string()]),
        ..Default::default()
    };

    let json = serde_json::to_value(&plugin).unwrap();

    assert_eq!(json["name"], "test-plugin");
    assert_eq!(json["description"], "A test plugin");
    assert!(json["actions"].is_array());
    assert!(json["dependencies"].is_array());
}

/// Test State structure
#[test]
fn test_state_structure() {
    let state = State {
        agent_id: Some("agent-123".to_string()),
        agent_name: Some("TestAgent".to_string()),
        room_id: Some("room-456".to_string()),
        recent_messages: Some(vec![]),
        goals: Some(vec![]),
        ..Default::default()
    };

    let json = serde_json::to_value(&state).unwrap();

    assert_eq!(json["agentId"], "agent-123");
    assert_eq!(json["agentName"], "TestAgent");
    assert_eq!(json["roomId"], "room-456");
}

/// Test Goal structure
#[test]
fn test_goal_structure() {
    let goal = Goal {
        id: Some("goal-123".to_string()),
        name: Some("Test Goal".to_string()),
        status: Some(TaskStatus::Pending),
        objectives: Some(vec![]),
        ..Default::default()
    };

    let json = serde_json::to_value(&goal).unwrap();

    assert!(json.get("id").is_some());
    assert!(json.get("name").is_some());
    assert!(json.get("status").is_some());
}

/// Test Task structure
#[test]
fn test_task_structure() {
    let task = Task {
        id: Some(UUID::new("550e8400-e29b-41d4-a716-446655440000").unwrap()),
        name: "Test Task".to_string(),
        description: Some("A test task".to_string()),
        status: Some(TaskStatus::Pending),
        room_id: Some(UUID::new("550e8400-e29b-41d4-a716-446655440001").unwrap()),
        ..Default::default()
    };

    let json = serde_json::to_value(&task).unwrap();

    assert_eq!(json["id"], "550e8400-e29b-41d4-a716-446655440000");
    assert_eq!(json["name"], "Test Task");
    assert_eq!(json["status"], "pending");
}

/// Test World structure
#[test]
fn test_world_structure() {
    let world = World {
        id: "world-123".to_string(),
        name: Some("Test World".to_string()),
        owner_id: Some("owner-456".to_string()),
        ..Default::default()
    };

    let json = serde_json::to_value(&world).unwrap();

    assert_eq!(json["id"], "world-123");
    assert_eq!(json["name"], "Test World");
    assert_eq!(json["ownerId"], "owner-456");
}

/// Test Component structure
#[test]
fn test_component_structure() {
    let component = Component {
        id: "comp-123".to_string(),
        entity_id: "entity-456".to_string(),
        agent_id: "agent-789".to_string(),
        room_id: "room-abc".to_string(),
        world_id: Some("world-def".to_string()),
        source_entity_id: Some("source-ghi".to_string()),
        component_type: "test".to_string(),
        data: serde_json::json!({"key": "value"}),
        ..Default::default()
    };

    let json = serde_json::to_value(&component).unwrap();

    assert_eq!(json["id"], "comp-123");
    assert_eq!(json["type"], "test");
    assert!(json["data"].is_object());
}

/// Test Relationship structure
#[test]
fn test_relationship_structure() {
    let relationship = Relationship {
        id: "rel-123".to_string(),
        source_entity_id: "source-456".to_string(),
        target_entity_id: "target-789".to_string(),
        agent_id: "agent-abc".to_string(),
        tags: Some(vec!["friend".to_string()]),
        ..Default::default()
    };

    let json = serde_json::to_value(&relationship).unwrap();

    assert_eq!(json["id"], "rel-123");
    assert_eq!(json["sourceEntityId"], "source-456");
    assert_eq!(json["targetEntityId"], "target-789");
    assert!(json["tags"].is_array());
}

/// Test ModelType enum
#[test]
fn test_model_type_enum() {
    let types = vec![
        (ModelType::TextSmall, "TEXT_SMALL"),
        (ModelType::TextLarge, "TEXT_LARGE"),
        (ModelType::TextEmbedding, "TEXT_EMBEDDING"),
        (ModelType::ImageDescription, "IMAGE_DESCRIPTION"),
        (ModelType::ImageGeneration, "IMAGE_GENERATION"),
        (ModelType::AudioTranscription, "AUDIO_TRANSCRIPTION"),
        (ModelType::TextToSpeech, "TEXT_TO_SPEECH"),
    ];

    for (model_type, expected) in types {
        let json = serde_json::to_value(&model_type).unwrap();
        assert_eq!(json, expected);
    }
}

/// Test EventType enum
#[test]
fn test_event_type_enum() {
    let types = vec![
        (EventType::WorldJoined, "WORLD_JOINED"),
        (EventType::WorldLeft, "WORLD_LEFT"),
        (EventType::WorldConnected, "WORLD_CONNECTED"),
        (EventType::MessageReceived, "MESSAGE_RECEIVED"),
        (EventType::MessageSent, "MESSAGE_SENT"),
        (EventType::ActionStarted, "ACTION_STARTED"),
        (EventType::ActionCompleted, "ACTION_COMPLETED"),
    ];

    for (event_type, expected) in types {
        let json = serde_json::to_value(&event_type).unwrap();
        assert_eq!(json, expected);
    }
}

/// Test that MemoryMetadata handles embeddings correctly
#[test]
fn test_memory_metadata_with_embedding() {
    let metadata = MemoryMetadata {
        memory_type: Some(MemoryType::Message),
        source: Some("test".to_string()),
        embedding: Some(vec![0.1, 0.2, 0.3, 0.4]),
        ..Default::default()
    };

    let json = serde_json::to_value(&metadata).unwrap();

    assert!(json["embedding"].is_array());
    let embedding = json["embedding"].as_array().unwrap();
    assert_eq!(embedding.len(), 4);
}

/// Test deserialization of complex nested structures
#[test]
fn test_complex_nested_deserialization() {
    let json = serde_json::json!({
        "name": "TestAgent",
        "system": "You are helpful",
        "bio": ["Line 1", "Line 2"],
        "topics": ["topic1", "topic2"],
        "settings": {
            "model": "gpt-4",
            "secrets": {
                "API_KEY": "secret"
            }
        },
        "messageExamples": [
            [
                {"name": "user", "content": {"text": "Hello"}},
                {"name": "agent", "content": {"text": "Hi!"}}
            ]
        ]
    });

    let character: Character = serde_json::from_value(json).unwrap();

    assert_eq!(character.name, "TestAgent");
    assert!(character.settings.is_some());
}

