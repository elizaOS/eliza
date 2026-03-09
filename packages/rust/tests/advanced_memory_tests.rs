use anyhow::Result;
use async_trait::async_trait;
use elizaos::advanced_memory;
use elizaos::advanced_memory::types::{LongTermMemory, LongTermMemoryCategory, MemoryConfig};
use elizaos::runtime::{AgentRuntime, DatabaseAdapter, RuntimeOptions};
use elizaos::types::agent::{Bio, Character};
use elizaos::types::{
    database::{GetMemoriesParams, SearchMemoriesParams},
    memory::Memory,
    primitives::UUID,
    Entity, Room, Task, World,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// ============================================================================
// Mock Database Adapter
// ============================================================================

/// In-memory database adapter for testing
#[derive(Default)]
struct MockDatabaseAdapter {
    memories: Mutex<HashMap<String, Memory>>,
    agents: Mutex<HashMap<String, elizaos::types::agent::Agent>>,
    rooms: Mutex<HashMap<String, Room>>,
    entities: Mutex<HashMap<String, Entity>>,
    worlds: Mutex<HashMap<String, World>>,
    tasks: Mutex<HashMap<String, Task>>,
    initialized: Mutex<bool>,
    last_get_memories_params: Mutex<Option<GetMemoriesParams>>,
}

#[async_trait]
impl DatabaseAdapter for MockDatabaseAdapter {
    async fn init(&self) -> Result<()> {
        let mut initialized = self.initialized.lock().unwrap();
        *initialized = true;
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let mut initialized = self.initialized.lock().unwrap();
        *initialized = false;
        Ok(())
    }

    async fn is_ready(&self) -> Result<bool> {
        let initialized = self.initialized.lock().unwrap();
        Ok(*initialized)
    }

    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<elizaos::types::agent::Agent>> {
        let agents = self.agents.lock().unwrap();
        Ok(agents.get(agent_id.as_str()).cloned())
    }

    async fn create_agent(&self, agent: &elizaos::types::agent::Agent) -> Result<bool> {
        let mut agents = self.agents.lock().unwrap();
        if let Some(id) = &agent.character.id {
            agents.insert(id.as_str().to_string(), agent.clone());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn update_agent(
        &self,
        agent_id: &UUID,
        agent: &elizaos::types::agent::Agent,
    ) -> Result<bool> {
        let mut agents = self.agents.lock().unwrap();
        agents.insert(agent_id.as_str().to_string(), agent.clone());
        Ok(true)
    }

    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool> {
        let mut agents = self.agents.lock().unwrap();
        Ok(agents.remove(agent_id.as_str()).is_some())
    }

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        {
            let mut last_params = self.last_get_memories_params.lock().unwrap();
            *last_params = Some(params.clone());
        }

        let memories = self.memories.lock().unwrap();
        let mut result: Vec<Memory> = memories.values().cloned().collect();

        // Filter by entity_id if provided
        if let Some(entity_id) = &params.entity_id {
            result.retain(|m| m.entity_id.as_str() == entity_id.as_str());
        }

        // Filter by room_id if provided
        if let Some(room_id) = &params.room_id {
            result.retain(|m| m.room_id.as_str() == room_id.as_str());
        }

        if let Some(start) = params.start {
            result.retain(|m| m.created_at.unwrap_or_default() >= start);
        }

        // Filter by count
        if let Some(count) = params.count {
            result.truncate(count as usize);
        }

        Ok(result)
    }

    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        let memories = self.memories.lock().unwrap();
        let mut result: Vec<Memory> = memories
            .values()
            .filter(|m| m.embedding.is_some())
            .cloned()
            .collect();

        if let Some(count) = params.count {
            result.truncate(count as usize);
        }

        Ok(result)
    }

    async fn create_memory(&self, memory: &Memory, _table_name: &str) -> Result<UUID> {
        let mut memories = self.memories.lock().unwrap();
        let id = memory.id.clone().unwrap_or_else(UUID::new_v4);
        let mut new_memory = memory.clone();
        new_memory.id = Some(id.clone());
        memories.insert(id.as_str().to_string(), new_memory);
        Ok(id)
    }

    async fn update_memory(&self, memory: &Memory) -> Result<bool> {
        let mut memories = self.memories.lock().unwrap();
        if let Some(id) = &memory.id {
            memories.insert(id.as_str().to_string(), memory.clone());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn delete_memory(&self, memory_id: &UUID) -> Result<()> {
        let mut memories = self.memories.lock().unwrap();
        memories.remove(memory_id.as_str());
        Ok(())
    }

    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>> {
        let memories = self.memories.lock().unwrap();
        Ok(memories.get(id.as_str()).cloned())
    }

    async fn create_world(&self, world: &World) -> Result<UUID> {
        let mut worlds = self.worlds.lock().unwrap();
        worlds.insert(world.id.as_str().to_string(), world.clone());
        Ok(world.id.clone())
    }

    async fn get_world(&self, id: &UUID) -> Result<Option<World>> {
        let worlds = self.worlds.lock().unwrap();
        Ok(worlds.get(id.as_str()).cloned())
    }

    async fn create_room(&self, room: &Room) -> Result<UUID> {
        let mut rooms = self.rooms.lock().unwrap();
        rooms.insert(room.id.as_str().to_string(), room.clone());
        Ok(room.id.clone())
    }

    async fn get_room(&self, id: &UUID) -> Result<Option<Room>> {
        let rooms = self.rooms.lock().unwrap();
        Ok(rooms.get(id.as_str()).cloned())
    }

    async fn update_room(&self, room: &Room) -> Result<bool> {
        let mut rooms = self.rooms.lock().unwrap();
        rooms.insert(room.id.as_str().to_string(), room.clone());
        Ok(true)
    }

    async fn create_entity(&self, entity: &Entity) -> Result<bool> {
        let mut entities = self.entities.lock().unwrap();
        if let Some(id) = &entity.id {
            entities.insert(id.as_str().to_string(), entity.clone());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn get_entity(&self, id: &UUID) -> Result<Option<Entity>> {
        let entities = self.entities.lock().unwrap();
        Ok(entities.get(id.as_str()).cloned())
    }

    async fn add_participant(&self, _entity_id: &UUID, _room_id: &UUID) -> Result<bool> {
        Ok(true)
    }

    async fn create_task(&self, task: &Task) -> Result<UUID> {
        let mut tasks = self.tasks.lock().unwrap();
        let id = task.id.clone().unwrap_or_else(UUID::new_v4);
        let mut new_task = task.clone();
        new_task.id = Some(id.clone());
        tasks.insert(id.as_str().to_string(), new_task);
        Ok(id)
    }

    async fn get_task(&self, id: &UUID) -> Result<Option<Task>> {
        let tasks = self.tasks.lock().unwrap();
        Ok(tasks.get(id.as_str()).cloned())
    }

    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()> {
        let mut tasks = self.tasks.lock().unwrap();
        tasks.insert(id.as_str().to_string(), task.clone());
        Ok(())
    }

    async fn delete_task(&self, id: &UUID) -> Result<()> {
        let mut tasks = self.tasks.lock().unwrap();
        tasks.remove(id.as_str());
        Ok(())
    }
}

#[tokio::test]
async fn advanced_memory_gated_on_character_flag() -> Result<()> {
    let adapter_on = Arc::new(MockDatabaseAdapter::default());
    let runtime_on = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "MemOn".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter_on.clone()),
        ..Default::default()
    })
    .await?;
    runtime_on.initialize().await?;
    assert!(runtime_on.get_service("memory").await.is_some());

    let adapter_off = Arc::new(MockDatabaseAdapter::default());
    let runtime_off = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "MemOff".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(false),
            ..Default::default()
        }),
        adapter: Some(adapter_off.clone()),
        ..Default::default()
    })
    .await?;
    runtime_off.initialize().await?;
    assert!(runtime_off.get_service("memory").await.is_none());
    Ok(())
}

#[tokio::test]
async fn long_term_memory_provider_returns_text_when_memories_exist() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "MemBehavior".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_id = elizaos::types::primitives::UUID::new_v4();
    ms.store_long_term_memory(LongTermMemory {
        id: elizaos::types::primitives::UUID::new_v4(),
        agent_id: runtime.agent_id.clone(),
        entity_id: entity_id.clone(),
        category: LongTermMemoryCategory::Semantic,
        content: "User likes concise answers".to_string(),
        confidence: Some(0.9),
        source: Some("test".to_string()),
        metadata: None,
        embedding: None,
        created_at: 0,
        updated_at: 0,
        last_accessed_at: None,
        access_count: None,
        similarity: None,
    })
    .await?;

    let msg = elizaos::types::memory::Memory::message(
        entity_id.clone(),
        elizaos::types::primitives::UUID::new_v4(),
        "hi",
    );
    let state = runtime.compose_state(&msg).await?;
    let value = state
        .get_value("longTermMemories")
        .expect("longTermMemories should be present in state");
    let text = value.as_str().expect("longTermMemories should be a string");
    assert!(text.contains("What I Know About You"));
    Ok(())
}

#[tokio::test]
async fn get_long_term_memories_returns_top_confidence_items() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "TestAgent".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_id = elizaos::types::primitives::UUID::new_v4();
    let agent_id = runtime.agent_id.clone();

    ms.store_long_term_memory(LongTermMemory {
        id: elizaos::types::primitives::UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: LongTermMemoryCategory::Semantic,
        content: "low".to_string(),
        confidence: Some(0.1),
        source: None,
        metadata: None,
        embedding: None,
        created_at: 0,
        updated_at: 0,
        last_accessed_at: None,
        access_count: None,
        similarity: None,
    })
    .await?;
    ms.store_long_term_memory(LongTermMemory {
        id: elizaos::types::primitives::UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: LongTermMemoryCategory::Semantic,
        content: "high".to_string(),
        confidence: Some(0.9),
        source: None,
        metadata: None,
        embedding: None,
        created_at: 0,
        updated_at: 0,
        last_accessed_at: None,
        access_count: None,
        similarity: None,
    })
    .await?;
    ms.store_long_term_memory(LongTermMemory {
        id: elizaos::types::primitives::UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: LongTermMemoryCategory::Semantic,
        content: "mid".to_string(),
        confidence: Some(0.5),
        source: None,
        metadata: None,
        embedding: None,
        created_at: 0,
        updated_at: 0,
        last_accessed_at: None,
        access_count: None,
        similarity: None,
    })
    .await?;

    let out = ms
        .get_long_term_memories(entity_id, None, 2)
        .await
        .expect("Failed to get memories");
    assert_eq!(out.len(), 2);
    assert!(out[0].confidence >= out[1].confidence);
    assert_eq!(out[0].content, "high");
    Ok(())
}

#[tokio::test]
async fn get_long_term_memories_handles_zero_limit() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "TestAgent".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_id = elizaos::types::primitives::UUID::new_v4();
    let out = ms
        .get_long_term_memories(entity_id, None, 0)
        .await
        .expect("Failed to get memories");
    assert!(out.is_empty());
    Ok(())
}

#[tokio::test]
async fn extraction_checkpointing_independent_pairs() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "CheckpointTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_a = UUID::new_v4();
    let entity_b = UUID::new_v4();
    let room = UUID::new_v4();

    let config = ms.get_config();
    let threshold = config.long_term_extraction_threshold;

    // Set checkpoint for entity_a
    ms.set_last_extraction_checkpoint(&entity_a, &room, threshold);

    // entity_b should still be eligible (no checkpoint)
    assert!(ms.should_run_extraction(&entity_b, &room, threshold));
    // entity_a should not (checkpoint just set)
    assert!(!ms.should_run_extraction(&entity_a, &room, threshold));
    Ok(())
}

#[tokio::test]
async fn extraction_checkpointing_interval_boundaries() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "IntervalTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity = UUID::new_v4();
    let room = UUID::new_v4();

    let config = ms.get_config();
    let threshold = config.long_term_extraction_threshold;
    let interval = config.long_term_extraction_interval;

    // Below threshold → should not run
    assert!(!ms.should_run_extraction(&entity, &room, threshold - 1));

    // At threshold, no checkpoint → should run
    assert!(ms.should_run_extraction(&entity, &room, threshold));

    // Set checkpoint at threshold, same count → should not run
    ms.set_last_extraction_checkpoint(&entity, &room, threshold);
    assert!(!ms.should_run_extraction(&entity, &room, threshold));

    // One more message → still in same interval → should not run
    assert!(!ms.should_run_extraction(&entity, &room, threshold + 1));

    // At next interval → should run
    assert!(ms.should_run_extraction(&entity, &room, threshold + interval));
    Ok(())
}

#[tokio::test]
async fn config_management_defaults_and_updates() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "ConfigTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    // defaults are sensible
    let config = ms.get_config();
    assert!(config.short_term_summarization_threshold > 0);
    assert!(config.long_term_extraction_threshold > 0);
    assert!(config.long_term_extraction_interval > 0);
    assert!(config.long_term_confidence_threshold > 0.0);

    // Update a field, others preserved
    let original_interval = config.long_term_extraction_interval;
    ms.update_config(MemoryConfig {
        short_term_summarization_threshold: 9999,
        ..config.clone()
    });
    let updated = ms.get_config();
    assert_eq!(updated.short_term_summarization_threshold, 9999);
    assert_eq!(updated.long_term_extraction_interval, original_interval);
    Ok(())
}

#[tokio::test]
async fn formatted_long_term_memories_groups_by_category() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "FormatTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_id = UUID::new_v4();
    let agent_id = runtime.agent_id.clone();

    // Store memories in different categories
    ms.store_long_term_memory(LongTermMemory {
        id: UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: LongTermMemoryCategory::Semantic,
        content: "Likes coffee".to_string(),
        confidence: Some(0.9),
        source: None,
        metadata: None,
        embedding: None,
        created_at: 0,
        updated_at: 0,
        last_accessed_at: None,
        access_count: None,
        similarity: None,
    })
    .await?;

    ms.store_long_term_memory(LongTermMemory {
        id: UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: LongTermMemoryCategory::Episodic,
        content: "Had meeting".to_string(),
        confidence: Some(0.85),
        source: None,
        metadata: None,
        embedding: None,
        created_at: 0,
        updated_at: 0,
        last_accessed_at: None,
        access_count: None,
        similarity: None,
    })
    .await?;

    let formatted = ms.get_formatted_long_term_memories(entity_id).await?;
    assert!(formatted.contains("Likes coffee"));
    assert!(formatted.contains("Had meeting"));
    // Should have category headers
    assert!(formatted.contains("Semantic") || formatted.contains("semantic"));
    assert!(formatted.contains("Episodic") || formatted.contains("episodic"));
    Ok(())
}

#[tokio::test]
async fn formatted_long_term_memories_empty() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "EmptyFormatTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_id = UUID::new_v4();
    let formatted = ms.get_formatted_long_term_memories(entity_id).await?;
    assert!(formatted.is_empty());
    Ok(())
}

#[tokio::test]
async fn formatted_long_term_memories_single_category() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "SingleCatTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let entity_id = UUID::new_v4();
    let agent_id = runtime.agent_id.clone();

    ms.store_long_term_memory(LongTermMemory {
        id: UUID::new_v4(),
        agent_id: agent_id.clone(),
        entity_id: entity_id.clone(),
        category: LongTermMemoryCategory::Procedural,
        content: "Knows how to ride a bike".to_string(),
        confidence: Some(0.95),
        source: None,
        metadata: None,
        embedding: None,
        created_at: 0,
        updated_at: 0,
        last_accessed_at: None,
        access_count: None,
        similarity: None,
    })
    .await?;

    let formatted = ms.get_formatted_long_term_memories(entity_id).await?;
    assert!(formatted.contains("Knows how to ride a bike"));
    assert!(formatted.contains("Procedural") || formatted.contains("procedural"));
    // Should NOT contain other categories
    assert!(!formatted.contains("Semantic") && !formatted.contains("semantic"));
    assert!(!formatted.contains("Episodic") && !formatted.contains("episodic"));
    Ok(())
}

#[tokio::test]
async fn config_returns_independent_copy() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "ConfigCopyTest".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let svc = runtime.get_service("memory").await.expect("memory service");
    let ms = svc
        .as_any()
        .downcast_ref::<advanced_memory::MemoryService>()
        .expect("downcast MemoryService");

    let config1 = ms.get_config();
    let original_threshold = config1.short_term_summarization_threshold;

    // Mutating config1 should NOT affect the service's internal config
    let mut modified = config1.clone();
    modified.short_term_summarization_threshold = 99999;
    // We just mutated a local copy — the service config should be unchanged
    let config2 = ms.get_config();
    assert_eq!(
        config2.short_term_summarization_threshold,
        original_threshold
    );
    Ok(())
}

#[tokio::test]
async fn advanced_memory_registers_reset_session_action_and_updates_compaction_marker() -> Result<()>
{
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let owner_id = UUID::new_v4();
    let world_id = UUID::new_v4();
    let room_id = UUID::new_v4();

    adapter
        .create_world(&World {
            id: world_id.clone(),
            name: Some("test-world".to_string()),
            agent_id: owner_id.clone(),
            message_server_id: None,
            metadata: Some(elizaos::types::WorldMetadata {
                ownership: None,
                roles: HashMap::from([(owner_id.to_string(), "OWNER".to_string())]),
                extra: HashMap::new(),
            }),
        })
        .await?;

    adapter
        .create_room(&Room {
            id: room_id.clone(),
            name: Some("test-room".to_string()),
            agent_id: Some(owner_id.clone()),
            source: "test".to_string(),
            room_type: "GROUP".to_string(),
            channel_id: None,
            message_server_id: None,
            world_id: Some(world_id),
            metadata: Some(elizaos::types::RoomMetadata {
                values: HashMap::from([("lastCompactionAt".to_string(), serde_json::json!(1000))]),
            }),
        })
        .await?;

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "CompactionAgent".to_string(),
            bio: Bio::Single("Test".to_string()),
            advanced_memory: Some(true),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let action_names: Vec<_> = runtime
        .list_action_definitions()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    assert!(action_names.iter().any(|name| name == "RESET_SESSION"));

    let message = Memory {
        id: Some(UUID::new_v4()),
        entity_id: owner_id,
        agent_id: Some(runtime.agent_id.clone()),
        created_at: Some(2000),
        content: elizaos::types::Content {
            text: Some("reset this session".to_string()),
            ..Default::default()
        },
        embedding: None,
        room_id: room_id.clone(),
        world_id: None,
        unique: Some(true),
        similarity: None,
        metadata: None,
    };

    let results = runtime
        .process_selected_actions(
            &message,
            &elizaos::types::State::new(),
            &["RESET_SESSION".to_string()],
            &HashMap::new(),
        )
        .await?;

    assert_eq!(results.len(), 1);
    assert!(results[0].success);

    let updated_room = adapter
        .get_room(&room_id)
        .await?
        .expect("room should exist");
    let updated_metadata = updated_room.metadata.expect("room metadata should exist");
    let new_compaction = updated_metadata
        .values
        .get("lastCompactionAt")
        .and_then(|value| value.as_i64())
        .expect("lastCompactionAt should be set");
    assert!(new_compaction >= 1000);

    let compaction_history = updated_metadata
        .values
        .get("compactionHistory")
        .and_then(|value| value.as_array())
        .expect("compactionHistory should be recorded");
    assert_eq!(compaction_history.len(), 1);

    Ok(())
}

#[tokio::test]
async fn bootstrap_recent_messages_provider_respects_last_compaction_boundary() -> Result<()> {
    let adapter = Arc::new(MockDatabaseAdapter::default());
    let room_id = UUID::new_v4();

    adapter
        .create_room(&Room {
            id: room_id.clone(),
            name: Some("history-room".to_string()),
            agent_id: Some(UUID::new_v4()),
            source: "test".to_string(),
            room_type: "GROUP".to_string(),
            channel_id: None,
            message_server_id: None,
            world_id: None,
            metadata: Some(elizaos::types::RoomMetadata {
                values: HashMap::from([("lastCompactionAt".to_string(), serde_json::json!(4242))]),
            }),
        })
        .await?;

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(Character {
            name: "RecentMessagesAgent".to_string(),
            bio: Bio::Single("Test".to_string()),
            ..Default::default()
        }),
        adapter: Some(adapter.clone()),
        ..Default::default()
    })
    .await?;
    runtime.initialize().await?;

    let message = Memory {
        id: Some(UUID::new_v4()),
        entity_id: UUID::new_v4(),
        agent_id: Some(runtime.agent_id.clone()),
        created_at: Some(5000),
        content: elizaos::types::Content {
            text: Some("show recent messages".to_string()),
            ..Default::default()
        },
        embedding: None,
        room_id,
        world_id: None,
        unique: Some(true),
        similarity: None,
        metadata: None,
    };

    let _ = runtime.compose_state(&message).await?;

    let last_params = adapter
        .last_get_memories_params
        .lock()
        .unwrap()
        .clone()
        .expect("provider should fetch recent messages");
    assert_eq!(last_params.start, Some(4242));

    Ok(())
}
