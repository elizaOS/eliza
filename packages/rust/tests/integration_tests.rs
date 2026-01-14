//! Integration tests for elizaOS Core
//!
//! These tests verify the complete agent runtime functionality including:
//! - Action handling and execution
//! - Provider context gathering
//! - Evaluator execution
//! - Memory CRUD operations
//! - Event handling
//! - Plugin registration

use anyhow::Result;
use async_trait::async_trait;
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, DatabaseAdapter, RuntimeOptions},
    types::{
        ActionDefinition, ActionHandler, ActionResult, Bio, Character, Content, Entity,
        EvaluationExample, EvaluatorDefinition, EvaluatorHandler, EventPayload, EventType,
        GetMemoriesParams, HandlerOptions, Memory, Plugin, PluginDefinition, ProviderDefinition,
        ProviderHandler, ProviderResult, Room, RuntimeSettings, SearchMemoriesParams, SettingValue,
        State, Task, World, UUID,
    },
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// ============================================================================
// Mock Database Adapter
// ============================================================================

/// In-memory database adapter for testing
#[derive(Default)]
struct MockDatabaseAdapter {
    memories: Mutex<HashMap<String, Memory>>,
    agents: Mutex<HashMap<String, elizaos::Agent>>,
    rooms: Mutex<HashMap<String, Room>>,
    entities: Mutex<HashMap<String, Entity>>,
    worlds: Mutex<HashMap<String, World>>,
    tasks: Mutex<HashMap<String, Task>>,
    initialized: Mutex<bool>,
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

    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<elizaos::Agent>> {
        let agents = self.agents.lock().unwrap();
        Ok(agents.get(agent_id.as_str()).cloned())
    }

    async fn create_agent(&self, agent: &elizaos::Agent) -> Result<bool> {
        let mut agents = self.agents.lock().unwrap();
        if let Some(id) = &agent.character.id {
            agents.insert(id.as_str().to_string(), agent.clone());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn update_agent(&self, agent_id: &UUID, agent: &elizaos::Agent) -> Result<bool> {
        let mut agents = self.agents.lock().unwrap();
        agents.insert(agent_id.as_str().to_string(), agent.clone());
        Ok(true)
    }

    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool> {
        let mut agents = self.agents.lock().unwrap();
        Ok(agents.remove(agent_id.as_str()).is_some())
    }

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        let memories = self.memories.lock().unwrap();
        let mut result: Vec<Memory> = memories.values().cloned().collect();

        // Filter by room_id if provided
        if let Some(room_id) = &params.room_id {
            result.retain(|m| m.room_id.as_str() == room_id.as_str());
        }

        // Filter by count
        if let Some(count) = params.count {
            result.truncate(count as usize);
        }

        Ok(result)
    }

    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        // For testing, return memories that match the embedding dimension check
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
        // For testing, always succeed
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

// ============================================================================
// Mock Action Handler - RESPOND action
// ============================================================================

/// Counter for tracking action executions
static RESPOND_ACTION_CALL_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Mock RESPOND action that generates a response
struct RespondAction {
    response_text: String,
}

impl RespondAction {
    fn new(response_text: &str) -> Self {
        Self {
            response_text: response_text.to_string(),
        }
    }
}

#[async_trait]
impl ActionHandler for RespondAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "RESPOND".to_string(),
            description: "Generate a response to the user's message".to_string(),
            similes: Some(vec![
                "reply".to_string(),
                "answer".to_string(),
                "message".to_string(),
            ]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        // Validate that the message has text content
        message.content.text.is_some()
    }

    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        RESPOND_ACTION_CALL_COUNT.fetch_add(1, Ordering::SeqCst);

        // Generate response using the state context
        let context = state.map(|s| s.text.as_str()).unwrap_or("");
        let user_text = message.content.text.as_deref().unwrap_or("");

        let response = format!(
            "{} [Context: {}] [User said: {}]",
            self.response_text, context, user_text
        );

        Ok(Some(ActionResult {
            success: true,
            text: Some(response),
            data: Some({
                let mut map = HashMap::new();
                map.insert(
                    "response_type".to_string(),
                    serde_json::Value::String("text".to_string()),
                );
                map
            }),
            ..Default::default()
        }))
    }
}

// ============================================================================
// Mock Action Handler - SEARCH action
// ============================================================================

/// Mock SEARCH action that searches for information
struct SearchAction;

#[async_trait]
impl ActionHandler for SearchAction {
    fn definition(&self) -> ActionDefinition {
        ActionDefinition {
            name: "SEARCH".to_string(),
            description: "Search for information".to_string(),
            similes: Some(vec!["find".to_string(), "lookup".to_string()]),
            examples: None,
            priority: None,
            tags: None,
            parameters: None,
        }
    }

    async fn validate(&self, message: &Memory, _state: Option<&State>) -> bool {
        // Validate that the message contains search keywords
        if let Some(text) = &message.content.text {
            text.to_lowercase().contains("search")
                || text.to_lowercase().contains("find")
                || text.to_lowercase().contains("lookup")
        } else {
            false
        }
    }

    async fn handle(
        &self,
        message: &Memory,
        _state: Option<&State>,
        _options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>> {
        let query = message.content.text.as_deref().unwrap_or("");

        Ok(Some(ActionResult {
            success: true,
            text: Some(format!("Search results for: {}", query)),
            data: Some({
                let mut map = HashMap::new();
                map.insert(
                    "results_count".to_string(),
                    serde_json::Value::Number(5.into()),
                );
                map
            }),
            ..Default::default()
        }))
    }
}

// ============================================================================
// Mock Provider Handler - User Context Provider
// ============================================================================

/// Mock provider that provides user context
struct UserContextProvider;

#[async_trait]
impl ProviderHandler for UserContextProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "USER_CONTEXT".to_string(),
            description: Some("Provides context about the current user".to_string()),
            dynamic: Some(false),
            position: Some(0),
            private: Some(false),
        }
    }

    async fn get(&self, message: &Memory, _state: &State) -> Result<ProviderResult> {
        Ok(ProviderResult {
            text: Some(format!(
                "User context: Speaking with entity {}",
                message.entity_id
            )),
            values: Some({
                let mut map = HashMap::new();
                map.insert(
                    "entity_id".to_string(),
                    serde_json::Value::String(message.entity_id.to_string()),
                );
                map
            }),
            data: None,
        })
    }
}

// ============================================================================
// Mock Provider Handler - Memory Provider
// ============================================================================

/// Mock provider that provides recent memories
struct MemoryProvider;

#[async_trait]
impl ProviderHandler for MemoryProvider {
    fn definition(&self) -> ProviderDefinition {
        ProviderDefinition {
            name: "MEMORY".to_string(),
            description: Some("Provides recent conversation history".to_string()),
            dynamic: Some(true),
            position: Some(1),
            private: Some(false),
        }
    }

    async fn get(&self, _message: &Memory, _state: &State) -> Result<ProviderResult> {
        Ok(ProviderResult {
            text: Some("Recent memories: [Memory 1] [Memory 2] [Memory 3]".to_string()),
            values: Some({
                let mut map = HashMap::new();
                map.insert(
                    "memory_count".to_string(),
                    serde_json::Value::Number(3.into()),
                );
                map
            }),
            data: None,
        })
    }
}

// ============================================================================
// Mock Evaluator Handler - Response Quality Evaluator
// ============================================================================

/// Mock evaluator that evaluates response quality
struct ResponseQualityEvaluator;

#[async_trait]
impl EvaluatorHandler for ResponseQualityEvaluator {
    fn definition(&self) -> EvaluatorDefinition {
        EvaluatorDefinition {
            name: "RESPONSE_QUALITY".to_string(),
            description: "Evaluates the quality of agent responses".to_string(),
            always_run: Some(true),
            similes: Some(vec!["quality_check".to_string()]),
            examples: vec![EvaluationExample {
                prompt: "Evaluate if the response is helpful".to_string(),
                messages: vec![],
                outcome: "Response is helpful and relevant".to_string(),
            }],
        }
    }

    async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
        true // Always validate for testing
    }

    async fn handle(
        &self,
        _message: &Memory,
        _state: Option<&State>,
    ) -> Result<Option<ActionResult>> {
        Ok(Some(ActionResult {
            success: true,
            text: Some("Response quality: GOOD".to_string()),
            data: Some({
                let mut map = HashMap::new();
                map.insert(
                    "quality_score".to_string(),
                    serde_json::Value::Number(serde_json::Number::from_f64(0.85).unwrap()),
                );
                map
            }),
            ..Default::default()
        }))
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

fn create_test_character() -> Character {
    Character {
        id: Some(UUID::new_v4()),
        name: "TestAgent".to_string(),
        username: Some("test_agent".to_string()),
        bio: Bio::Multiple(vec![
            "An AI assistant for testing".to_string(),
            "Helpful and thorough".to_string(),
        ]),
        system: Some("You are a helpful test agent.".to_string()),
        topics: Some(vec!["testing".to_string(), "development".to_string()]),
        adjectives: Some(vec!["helpful".to_string(), "thorough".to_string()]),
        plugins: Some(vec!["@elizaos/plugin-sql".to_string()]),
        ..Default::default()
    }
}

fn create_test_message(entity_id: UUID, room_id: UUID, text: &str) -> Memory {
    Memory {
        id: Some(UUID::new_v4()),
        entity_id,
        agent_id: None,
        room_id,
        world_id: None,
        content: Content {
            text: Some(text.to_string()),
            ..Default::default()
        },
        embedding: None,
        created_at: Some(chrono::Utc::now().timestamp_millis()),
        unique: Some(true),
        similarity: None,
        metadata: None,
    }
}

fn create_test_plugin() -> Plugin {
    let respond_action = Arc::new(RespondAction::new("Hello! I'm here to help."));
    let search_action = Arc::new(SearchAction);
    let user_context_provider = Arc::new(UserContextProvider);
    let memory_provider = Arc::new(MemoryProvider);
    let quality_evaluator = Arc::new(ResponseQualityEvaluator);

    Plugin {
        definition: PluginDefinition {
            name: "test-plugin".to_string(),
            description: "A test plugin with actions, providers, and evaluators".to_string(),
            ..Default::default()
        },
        action_handlers: vec![respond_action, search_action],
        provider_handlers: vec![user_context_provider, memory_provider],
        evaluator_handlers: vec![quality_evaluator],
        model_handlers: std::collections::HashMap::new(),
        tests: vec![],
        init: None,
    }
}

// ============================================================================
// Tests
// ============================================================================

mod runtime_tests {
    use super::*;

    /// Test that we can create an agent runtime with a character
    #[tokio::test]
    async fn test_create_runtime_with_character() {
        let character = create_test_character();

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(character.clone()),
            ..Default::default()
        })
        .await
        .unwrap();

        #[cfg(feature = "native")]
        let runtime_character = runtime.character.read().await.clone();
        #[cfg(not(feature = "native"))]
        let runtime_character = runtime.character.read().unwrap().clone();
        assert_eq!(runtime_character.name, "TestAgent");
        assert_eq!(runtime_character.username, Some("test_agent".to_string()));
    }

    /// Test that we can initialize the runtime with a database adapter
    #[tokio::test]
    async fn test_runtime_initialization() {
        let adapter = Arc::new(MockDatabaseAdapter::default());

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            adapter: Some(adapter.clone()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.initialize().await.unwrap();

        // Verify adapter was initialized
        assert!(adapter.is_ready().await.unwrap());
    }

    /// Test loading character from JSON
    #[tokio::test]
    async fn test_load_character_from_json() {
        let json = r#"{
            "name": "JSONAgent",
            "bio": "Loaded from JSON",
            "system": "You are a JSON-loaded agent.",
            "topics": ["json", "parsing"],
            "messageExamples": [
                [
                    {"name": "user", "content": {"text": "Hello"}},
                    {"name": "JSONAgent", "content": {"text": "Hi there!"}}
                ]
            ]
        }"#;

        let character = parse_character(json).unwrap();

        assert_eq!(character.name, "JSONAgent");
        assert!(character.system.is_some());
        assert!(character.message_examples.is_some());

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            ..Default::default()
        })
        .await
        .unwrap();

        #[cfg(feature = "native")]
        let runtime_character = runtime.character.read().await.clone();
        #[cfg(not(feature = "native"))]
        let runtime_character = runtime.character.read().unwrap().clone();
        assert_eq!(runtime_character.name, "JSONAgent");
    }
}

mod action_tests {
    use super::*;

    /// Test registering and executing an action
    #[tokio::test]
    async fn test_action_registration_and_execution() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        // Register the test plugin
        runtime.register_plugin(create_test_plugin()).await.unwrap();

        // Create a test message
        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let message = create_test_message(entity_id, room_id, "Hello, agent!");

        // Compose state
        let state = runtime.compose_state(&message).await.unwrap();

        // Process actions
        let initial_count = RESPOND_ACTION_CALL_COUNT.load(Ordering::SeqCst);
        let results = runtime
            .process_actions(&message, &state, None)
            .await
            .unwrap();

        // Verify RESPOND action was called
        assert!(RESPOND_ACTION_CALL_COUNT.load(Ordering::SeqCst) > initial_count);

        // Verify we got results
        assert!(!results.is_empty());
        assert!(results[0].success);
        assert!(results[0].text.is_some());
    }

    /// Test action validation - SEARCH action only triggers on search keywords
    #[tokio::test]
    async fn test_action_validation() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.register_plugin(create_test_plugin()).await.unwrap();

        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();

        // Message WITHOUT search keywords - should only trigger RESPOND
        let message1 = create_test_message(entity_id.clone(), room_id.clone(), "Just saying hello");

        let state1 = runtime.compose_state(&message1).await.unwrap();
        let results1 = runtime
            .process_actions(&message1, &state1, None)
            .await
            .unwrap();

        // Should have 1 result (RESPOND only)
        assert_eq!(results1.len(), 1);

        // Message WITH search keywords - should trigger both RESPOND and SEARCH
        let message2 = create_test_message(
            entity_id,
            room_id,
            "Please search for information about Rust",
        );

        let state2 = runtime.compose_state(&message2).await.unwrap();
        let results2 = runtime
            .process_actions(&message2, &state2, None)
            .await
            .unwrap();

        // Should have 2 results (RESPOND + SEARCH)
        assert_eq!(results2.len(), 2);
    }

    /// Test that action results contain expected data
    #[tokio::test]
    async fn test_action_result_data() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.register_plugin(create_test_plugin()).await.unwrap();

        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let message = create_test_message(entity_id, room_id, "search for Rust documentation");

        let state = runtime.compose_state(&message).await.unwrap();
        let results = runtime
            .process_actions(&message, &state, None)
            .await
            .unwrap();

        // Find the SEARCH result
        let search_result = results.iter().find(|r| {
            r.data
                .as_ref()
                .is_some_and(|d| d.contains_key("results_count"))
        });

        assert!(search_result.is_some());
        let search_data = search_result.unwrap().data.as_ref().unwrap();
        assert_eq!(
            search_data.get("results_count").unwrap(),
            &serde_json::Value::Number(5.into())
        );
    }
}

mod provider_tests {
    use super::*;

    /// Test that providers contribute to state
    #[tokio::test]
    async fn test_provider_state_composition() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.register_plugin(create_test_plugin()).await.unwrap();

        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let message = create_test_message(entity_id.clone(), room_id, "Hello!");

        let state = runtime.compose_state(&message).await.unwrap();

        // Verify state contains provider text
        assert!(state.text.contains("User context:"));
        assert!(state.text.contains("Recent memories:"));

        // Verify state contains provider values
        assert!(state.values.contains_key("entity_id"));
        assert!(state.values.contains_key("memory_count"));
    }

    /// Test that private providers are skipped
    #[tokio::test]
    async fn test_private_provider_skipped() {
        // Create a plugin with a private provider
        struct PrivateProvider;

        #[async_trait]
        impl ProviderHandler for PrivateProvider {
            fn definition(&self) -> ProviderDefinition {
                ProviderDefinition {
                    name: "PRIVATE_DATA".to_string(),
                    description: Some("Private provider".to_string()),
                    dynamic: Some(false),
                    position: None,
                    private: Some(true), // Mark as private
                }
            }

            async fn get(&self, _message: &Memory, _state: &State) -> Result<ProviderResult> {
                Ok(ProviderResult {
                    text: Some("PRIVATE DATA - SHOULD NOT APPEAR".to_string()),
                    values: None,
                    data: None,
                })
            }
        }

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        let plugin = Plugin {
            definition: PluginDefinition {
                name: "private-plugin".to_string(),
                description: "Plugin with private provider".to_string(),
                ..Default::default()
            },
            provider_handlers: vec![Arc::new(PrivateProvider)],
            ..Default::default()
        };

        runtime.register_plugin(plugin).await.unwrap();

        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let message = create_test_message(entity_id, room_id, "Hello!");

        let state = runtime.compose_state(&message).await.unwrap();

        // Private provider text should NOT appear
        assert!(!state.text.contains("PRIVATE DATA"));
    }
}

mod memory_tests {
    use super::*;

    /// Test memory CRUD operations
    #[tokio::test]
    async fn test_memory_crud() {
        let adapter = Arc::new(MockDatabaseAdapter::default());

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            adapter: Some(adapter.clone()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.initialize().await.unwrap();

        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();

        // Create memory
        let memory = create_test_message(entity_id.clone(), room_id.clone(), "Test memory content");
        let memory_id = adapter.create_memory(&memory, "memories").await.unwrap();

        // Read memory
        let retrieved = adapter.get_memory_by_id(&memory_id).await.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(
            retrieved.as_ref().unwrap().content.text,
            memory.content.text
        );

        // Update memory
        let mut updated_memory = retrieved.unwrap();
        updated_memory.content.text = Some("Updated content".to_string());
        adapter.update_memory(&updated_memory).await.unwrap();

        let re_retrieved = adapter.get_memory_by_id(&memory_id).await.unwrap();
        assert_eq!(
            re_retrieved.unwrap().content.text,
            Some("Updated content".to_string())
        );

        // Delete memory
        adapter.delete_memory(&memory_id).await.unwrap();
        let deleted = adapter.get_memory_by_id(&memory_id).await.unwrap();
        assert!(deleted.is_none());
    }

    /// Test getting memories by room
    #[tokio::test]
    async fn test_get_memories_by_room() {
        let adapter = Arc::new(MockDatabaseAdapter::default());

        let room_id = UUID::new_v4();
        let entity_id = UUID::new_v4();

        // Create multiple memories in the same room
        for i in 0..5 {
            let memory = create_test_message(
                entity_id.clone(),
                room_id.clone(),
                &format!("Message {}", i),
            );
            adapter.create_memory(&memory, "memories").await.unwrap();
        }

        // Create a memory in a different room
        let other_room_id = UUID::new_v4();
        let other_memory =
            create_test_message(entity_id.clone(), other_room_id, "Other room message");
        adapter
            .create_memory(&other_memory, "memories")
            .await
            .unwrap();

        // Get memories for the first room
        let params = GetMemoriesParams {
            room_id: Some(room_id.clone()),
            table_name: "memories".to_string(),
            ..Default::default()
        };

        let memories = adapter.get_memories(params).await.unwrap();

        // Should only get memories from the first room
        assert_eq!(memories.len(), 5);
        for memory in &memories {
            assert_eq!(memory.room_id.as_str(), room_id.as_str());
        }
    }

    /// Test searching memories with embeddings
    #[tokio::test]
    async fn test_search_memories_with_embedding() {
        let adapter = Arc::new(MockDatabaseAdapter::default());

        let room_id = UUID::new_v4();
        let entity_id = UUID::new_v4();

        // Create memory with embedding
        let mut memory_with_embedding =
            create_test_message(entity_id.clone(), room_id.clone(), "Embedded memory");
        memory_with_embedding.embedding = Some(vec![0.1, 0.2, 0.3, 0.4, 0.5]);
        adapter
            .create_memory(&memory_with_embedding, "memories")
            .await
            .unwrap();

        // Create memory without embedding
        let memory_without_embedding =
            create_test_message(entity_id, room_id.clone(), "No embedding");
        adapter
            .create_memory(&memory_without_embedding, "memories")
            .await
            .unwrap();

        // Search memories (should only return those with embeddings)
        let params = SearchMemoriesParams {
            embedding: vec![0.1, 0.2, 0.3, 0.4, 0.5],
            room_id: Some(room_id),
            count: Some(10),
            table_name: "memories".to_string(),
            match_threshold: None,
            unique: None,
            query: None,
            world_id: None,
            entity_id: None,
        };

        let results = adapter.search_memories(params).await.unwrap();

        // Should only find the memory with embedding
        assert_eq!(results.len(), 1);
        assert!(results[0].embedding.is_some());
    }
}

mod event_tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// Test event registration and emission
    #[tokio::test]
    async fn test_event_handling() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        let event_received = Arc::new(AtomicBool::new(false));
        let event_received_clone = event_received.clone();

        // Register event handler
        let handler: Arc<dyn Fn(EventPayload) -> Result<()> + Send + Sync> = Arc::new(move |_| {
            event_received_clone.store(true, Ordering::SeqCst);
            Ok(())
        });

        runtime
            .register_event(EventType::MessageReceived, handler)
            .await;

        // Emit event
        let payload = EventPayload {
            source: "test".to_string(),
            extra: HashMap::new(),
        };

        runtime
            .emit_event(EventType::MessageReceived, payload)
            .await
            .unwrap();

        // Verify event was received
        assert!(event_received.load(Ordering::SeqCst));
    }
}

mod run_management_tests {
    use super::*;

    /// Test run ID management
    #[tokio::test]
    async fn test_run_lifecycle() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        let room_id = UUID::new_v4();

        // Start a run
        let run_id = runtime.start_run(Some(&room_id));

        // Verify run ID was generated
        assert!(!run_id.as_str().is_empty());

        // End the run
        runtime.end_run();
    }

    /// Test that multiple runs generate unique IDs
    #[tokio::test]
    async fn test_unique_run_ids() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        let room_id = UUID::new_v4();

        let run_id_1 = runtime.start_run(Some(&room_id));
        runtime.end_run();

        let run_id_2 = runtime.start_run(Some(&room_id));
        runtime.end_run();

        // Run IDs should be different
        assert_ne!(run_id_1.as_str(), run_id_2.as_str());
    }
}

mod settings_tests {
    use super::*;
    use elizaos::types::LLMMode;

    /// Test runtime settings
    #[tokio::test]
    async fn test_runtime_settings() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        // Set and get string settings
        runtime
            .set_setting(
                "API_KEY",
                SettingValue::String("test-key-123".to_string()),
                false,
            )
            .await;
        let value = runtime.get_setting("API_KEY").await;
        assert_eq!(
            value,
            Some(SettingValue::String("test-key-123".to_string()))
        );

        // Get non-existent setting
        let missing = runtime.get_setting("MISSING_KEY").await;
        assert!(missing.is_none());
    }

    /// Test settings persistence
    #[tokio::test]
    async fn test_settings_persistence() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            settings: Some(RuntimeSettings {
                values: {
                    let mut map = HashMap::new();
                    map.insert(
                        "PRESET_KEY".to_string(),
                        SettingValue::String("preset_value".to_string()),
                    );
                    map
                },
            }),
            ..Default::default()
        })
        .await
        .unwrap();

        // Verify preset setting exists
        let value = runtime.get_setting("PRESET_KEY").await;
        assert_eq!(
            value,
            Some(SettingValue::String("preset_value".to_string()))
        );
    }

    /// Test LLM mode defaults to DEFAULT
    #[tokio::test]
    async fn test_llm_mode_default() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        let mode = runtime.get_llm_mode().await;
        assert_eq!(mode, LLMMode::Default);
    }

    /// Test LLM mode from constructor option
    #[tokio::test]
    async fn test_llm_mode_constructor_option() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            llm_mode: Some(LLMMode::Small),
            ..Default::default()
        })
        .await
        .unwrap();

        let mode = runtime.get_llm_mode().await;
        assert_eq!(mode, LLMMode::Small);
    }

    /// Test LLM mode LARGE from constructor option
    #[tokio::test]
    async fn test_llm_mode_large_constructor_option() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            llm_mode: Some(LLMMode::Large),
            ..Default::default()
        })
        .await
        .unwrap();

        let mode = runtime.get_llm_mode().await;
        assert_eq!(mode, LLMMode::Large);
    }

    /// Test LLM mode from character setting
    #[tokio::test]
    async fn test_llm_mode_from_setting() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        // Set LLM_MODE via settings
        runtime
            .set_setting("LLM_MODE", SettingValue::String("SMALL".to_string()), false)
            .await;

        let mode = runtime.get_llm_mode().await;
        assert_eq!(mode, LLMMode::Small);
    }

    /// Test LLM mode constructor option takes precedence over setting
    #[tokio::test]
    async fn test_llm_mode_constructor_precedence() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            llm_mode: Some(LLMMode::Large),
            ..Default::default()
        })
        .await
        .unwrap();

        // Set a different LLM_MODE via settings
        runtime
            .set_setting("LLM_MODE", SettingValue::String("SMALL".to_string()), false)
            .await;

        // Constructor option should take precedence
        let mode = runtime.get_llm_mode().await;
        assert_eq!(mode, LLMMode::Large);
    }

    /// Test checkShouldRespond defaults to true
    #[tokio::test]
    async fn test_check_should_respond_default() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        let enabled = runtime.is_check_should_respond_enabled().await;
        assert!(enabled);
    }

    /// Test checkShouldRespond from constructor option (disabled)
    #[tokio::test]
    async fn test_check_should_respond_disabled_via_constructor() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            check_should_respond: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();

        let enabled = runtime.is_check_should_respond_enabled().await;
        assert!(!enabled);
    }

    /// Test checkShouldRespond from constructor option (enabled)
    #[tokio::test]
    async fn test_check_should_respond_enabled_via_constructor() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            check_should_respond: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();

        let enabled = runtime.is_check_should_respond_enabled().await;
        assert!(enabled);
    }

    /// Test checkShouldRespond from character setting
    #[tokio::test]
    async fn test_check_should_respond_from_setting() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        // Set CHECK_SHOULD_RESPOND to false via settings
        runtime
            .set_setting(
                "CHECK_SHOULD_RESPOND",
                SettingValue::String("false".to_string()),
                false,
            )
            .await;

        let enabled = runtime.is_check_should_respond_enabled().await;
        assert!(!enabled);
    }

    /// Test checkShouldRespond from boolean setting
    #[tokio::test]
    async fn test_check_should_respond_from_bool_setting() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        // Set CHECK_SHOULD_RESPOND to boolean false via settings
        runtime
            .set_setting("CHECK_SHOULD_RESPOND", SettingValue::Bool(false), false)
            .await;

        let enabled = runtime.is_check_should_respond_enabled().await;
        assert!(!enabled);
    }

    /// Test checkShouldRespond constructor option takes precedence over setting
    #[tokio::test]
    async fn test_check_should_respond_constructor_precedence() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            check_should_respond: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();

        // Set a different value via settings
        runtime
            .set_setting("CHECK_SHOULD_RESPOND", SettingValue::Bool(true), false)
            .await;

        // Constructor option should take precedence
        let enabled = runtime.is_check_should_respond_enabled().await;
        assert!(!enabled);
    }
}

mod plugin_tests {
    use super::*;

    /// Test plugin registration
    #[tokio::test]
    async fn test_plugin_registration() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        let plugin = create_test_plugin();
        let _plugin_name = plugin.definition.name.clone();

        runtime.register_plugin(plugin).await.unwrap();

        // Plugin should be registered (verified by being able to use its actions)
        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let message = create_test_message(entity_id, room_id, "Test message");

        let state = runtime.compose_state(&message).await.unwrap();
        let results = runtime
            .process_actions(&message, &state, None)
            .await
            .unwrap();

        // Should have action results from the plugin
        assert!(!results.is_empty());
    }

    /// Test plugin with all component types
    #[tokio::test]
    async fn test_full_plugin_integration() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.register_plugin(create_test_plugin()).await.unwrap();

        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();
        let message = create_test_message(entity_id, room_id, "Hello! Please search for help.");

        // Step 1: Compose state (uses providers)
        let state = runtime.compose_state(&message).await.unwrap();
        assert!(
            !state.text.is_empty(),
            "Providers should contribute to state"
        );

        // Step 2: Process actions
        let action_results = runtime
            .process_actions(&message, &state, None)
            .await
            .unwrap();
        assert!(!action_results.is_empty(), "Actions should produce results");

        // Verify both RESPOND and SEARCH actions ran
        let has_search_result = action_results.iter().any(|r| {
            r.data
                .as_ref()
                .is_some_and(|d| d.contains_key("results_count"))
        });
        assert!(has_search_result, "SEARCH action should have run");

        let has_respond_result = action_results.iter().any(|r| {
            r.data
                .as_ref()
                .is_some_and(|d| d.contains_key("response_type"))
        });
        assert!(has_respond_result, "RESPOND action should have run");
    }
}

mod database_adapter_tests {
    use super::*;

    /// Test room and entity operations
    #[tokio::test]
    async fn test_room_entity_operations() {
        let adapter = Arc::new(MockDatabaseAdapter::default());
        adapter.init().await.unwrap();

        // Create world
        let world = World {
            id: UUID::new_v4(),
            name: Some("Test World".to_string()),
            agent_id: UUID::new_v4(),
            message_server_id: None,
            metadata: None,
        };
        adapter.create_world(&world).await.unwrap();

        // Create room
        let room = Room::new("test-room", "test", elizaos::types::ChannelType::Group);
        let room_id = adapter.create_room(&room).await.unwrap();

        // Retrieve room
        let retrieved_room = adapter.get_room(&room_id).await.unwrap();
        assert!(retrieved_room.is_some());

        // Create entity
        let entity = Entity::new("TestUser", world.agent_id.clone());
        let entity_id = entity.id.clone().unwrap();
        adapter.create_entity(&entity).await.unwrap();

        // Retrieve entity
        let retrieved_entity = adapter.get_entity(&entity_id).await.unwrap();
        assert!(retrieved_entity.is_some());

        // Add participant
        let result = adapter.add_participant(&entity_id, &room_id).await.unwrap();
        assert!(result);
    }

    /// Test task operations
    #[tokio::test]
    async fn test_task_operations() {
        let adapter = Arc::new(MockDatabaseAdapter::default());
        adapter.init().await.unwrap();

        // Create task
        let task = Task::new("test-task");
        let task_id = adapter.create_task(&task).await.unwrap();

        // Retrieve task
        let retrieved = adapter.get_task(&task_id).await.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.as_ref().unwrap().name, "test-task");

        // Update task
        let mut updated_task = retrieved.unwrap();
        updated_task.description = Some("Updated description".to_string());
        adapter.update_task(&task_id, &updated_task).await.unwrap();

        let re_retrieved = adapter.get_task(&task_id).await.unwrap();
        assert_eq!(
            re_retrieved.unwrap().description,
            Some("Updated description".to_string())
        );

        // Delete task
        adapter.delete_task(&task_id).await.unwrap();
        let deleted = adapter.get_task(&task_id).await.unwrap();
        assert!(deleted.is_none());
    }
}

mod end_to_end_tests {
    use super::*;

    /// Full end-to-end test simulating an agent conversation
    #[tokio::test]
    async fn test_agent_conversation_flow() {
        // Setup
        let adapter = Arc::new(MockDatabaseAdapter::default());

        let character = create_test_character();
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            adapter: Some(adapter.clone()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.initialize().await.unwrap();
        runtime.register_plugin(create_test_plugin()).await.unwrap();

        // Create conversation context
        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();

        // Start a run
        let _run_id = runtime.start_run(Some(&room_id));

        // User sends first message
        let user_message_1 =
            create_test_message(entity_id.clone(), room_id.clone(), "Hello! Who are you?");

        // Store message
        adapter
            .create_memory(&user_message_1, "memories")
            .await
            .unwrap();

        // Agent processes message
        let state_1 = runtime.compose_state(&user_message_1).await.unwrap();
        let results_1 = runtime
            .process_actions(&user_message_1, &state_1, None)
            .await
            .unwrap();

        assert!(!results_1.is_empty());
        assert!(results_1[0].success);

        // Create and store agent response
        let agent_response_1 = create_test_message(
            runtime.agent_id.clone(),
            room_id.clone(),
            results_1[0].text.as_deref().unwrap_or("Hello!"),
        );
        adapter
            .create_memory(&agent_response_1, "memories")
            .await
            .unwrap();

        // User sends second message
        let user_message_2 = create_test_message(
            entity_id.clone(),
            room_id.clone(),
            "Can you search for information about Rust programming?",
        );
        adapter
            .create_memory(&user_message_2, "memories")
            .await
            .unwrap();

        // Agent processes second message
        let state_2 = runtime.compose_state(&user_message_2).await.unwrap();
        let results_2 = runtime
            .process_actions(&user_message_2, &state_2, None)
            .await
            .unwrap();

        // Should include both RESPOND and SEARCH results (bootstrap adds additional actions).
        let mut has_respond = false;
        let mut has_search = false;
        for r in &results_2 {
            if let Some(t) = &r.text {
                if t.contains("[User said:") {
                    has_respond = true;
                }
                if t.starts_with("Search results for:") {
                    has_search = true;
                }
            }
            if let Some(data) = &r.data {
                if let Some(serde_json::Value::Number(n)) = data.get("results_count") {
                    if n.as_u64() == Some(5) {
                        has_search = true;
                    }
                }
            }
        }
        assert!(has_respond, "RESPOND action should have run");
        assert!(has_search, "SEARCH action should have run");

        // End the run
        runtime.end_run();

        // Verify memories were stored
        let memories = adapter
            .get_memories(GetMemoriesParams {
                room_id: Some(room_id),
                table_name: "memories".to_string(),
                ..Default::default()
            })
            .await
            .unwrap();

        // Should have at least the user messages
        assert!(
            memories.len() >= 2,
            "Should have at least user messages stored"
        );
    }

    /// Test agent with complex multi-action scenario
    #[tokio::test]
    async fn test_multi_action_scenario() {
        let adapter = Arc::new(MockDatabaseAdapter::default());

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(create_test_character()),
            adapter: Some(adapter.clone()),
            ..Default::default()
        })
        .await
        .unwrap();

        runtime.initialize().await.unwrap();
        runtime.register_plugin(create_test_plugin()).await.unwrap();

        let entity_id = UUID::new_v4();
        let room_id = UUID::new_v4();

        // Message that should trigger multiple actions
        let message = create_test_message(
            entity_id,
            room_id.clone(),
            "Hello! Please search for documentation and provide a summary.",
        );

        let state = runtime.compose_state(&message).await.unwrap();
        let results = runtime
            .process_actions(&message, &state, None)
            .await
            .unwrap();

        // Verify both actions executed (bootstrap adds additional actions).
        let mut has_respond = false;
        let mut has_search = false;
        for r in &results {
            if let Some(t) = &r.text {
                if t.contains("[User said:") {
                    has_respond = true;
                }
                if t.starts_with("Search results for:") {
                    has_search = true;
                }
            }
            if let Some(data) = &r.data {
                if let Some(serde_json::Value::Number(n)) = data.get("results_count") {
                    if n.as_u64() == Some(5) {
                        has_search = true;
                    }
                }
            }
        }
        assert!(has_respond, "RESPOND action should have run");
        assert!(has_search, "SEARCH action should have run");

        // All results should be successful
        for result in &results {
            assert!(result.success);
            assert!(result.text.is_some());
        }
    }
}

// Helper for using chrono in tests
mod chrono {
    pub struct Utc;
    impl Utc {
        pub fn now() -> Self {
            Self
        }
    }
    impl Utc {
        pub fn timestamp_millis(&self) -> i64 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
        }
    }
}
