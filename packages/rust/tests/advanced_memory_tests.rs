use anyhow::Result;
use elizaos::runtime::RuntimeOptions;
use elizaos::types::agent::{Bio, Character};
use elizaos::{advanced_memory, AgentRuntime};
use serde_json::Value;

#[tokio::test]
async fn advanced_memory_gated_on_character_flag() -> Result<()> {
    let runtime_on = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "MemOn".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;
    runtime_on.initialize().await?;
    assert!(runtime_on.get_service("memory").await.is_some());

    let runtime_off = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "MemOff".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;
    runtime_off.initialize().await?;
    assert!(runtime_off.get_service("memory").await.is_none());
    Ok(())
}

#[tokio::test]
async fn long_term_memory_provider_returns_text_when_memories_exist() -> Result<()> {
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "MemBehavior".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_id = elizaos::UUID::new_v4();
    ms.store_long_term_memory(advanced_memory::LongTermMemory {
        id: elizaos::UUID::new_v4(),
        agent_id: runtime.agent_id.clone(),
        entity_id: entity_id.clone(),
        category: advanced_memory::LongTermMemoryCategory::Semantic,
        content: "User likes concise answers".to_string(),
        confidence: 0.9,
        source: Some("test".to_string()),
        metadata: Value::Object(Default::default()),
    });

    let msg = elizaos::Memory::message(entity_id.clone(), elizaos::UUID::new_v4(), "hi");
    let state = runtime.compose_state(&msg).await?;
    assert!(state.text.contains("What I Know About You"));
    Ok(())
}

#[test]
fn get_long_term_memories_returns_top_confidence_items() {
    let service = advanced_memory::MemoryService::default();
    let entity_id = elizaos::UUID::new_v4();
    let agent_id = elizaos::UUID::new_v4();

    service.store_long_term_memory(advanced_memory::LongTermMemory {
        id: elizaos::UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: advanced_memory::LongTermMemoryCategory::Semantic,
        content: "low".to_string(),
        confidence: 0.1,
        source: None,
        metadata: Value::Object(Default::default()),
    });
    service.store_long_term_memory(advanced_memory::LongTermMemory {
        id: elizaos::UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: advanced_memory::LongTermMemoryCategory::Semantic,
        content: "high".to_string(),
        confidence: 0.9,
        source: None,
        metadata: Value::Object(Default::default()),
    });
    service.store_long_term_memory(advanced_memory::LongTermMemory {
        id: elizaos::UUID::new_v4(),
        agent_id,
        entity_id: entity_id.clone(),
        category: advanced_memory::LongTermMemoryCategory::Semantic,
        content: "mid".to_string(),
        confidence: 0.5,
        source: None,
        metadata: Value::Object(Default::default()),
    });

    let out = service.get_long_term_memories(entity_id, 2);
    assert_eq!(out.len(), 2);
    assert!(out[0].confidence >= out[1].confidence);
    assert_eq!(out[0].content, "high");
}

#[test]
fn get_long_term_memories_handles_zero_limit() {
    let service = advanced_memory::MemoryService::default();
    let entity_id = elizaos::UUID::new_v4();
    let out = service.get_long_term_memories(entity_id, 0);
    assert!(out.is_empty());
}
