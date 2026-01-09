//! AgentRuntime implementation for elizaOS
//!
//! This module provides the core runtime for elizaOS agents.

use crate::types::{
    ActionHandler, ActionResult, Agent, Character, Entity, EvaluatorHandler, EventPayload,
    EventType, GetMemoriesParams, HandlerOptions, Memory, Plugin, ProviderHandler, Room,
    RuntimeSettings, SearchMemoriesParams, State, Task, World, UUID,
};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, error, info, warn};

// RwLock type - different for native (async) vs wasm (sync)
#[cfg(not(feature = "wasm"))]
use tokio::sync::RwLock;

#[cfg(feature = "wasm")]
use std::sync::RwLock;

/// Database adapter trait for runtime storage operations
#[async_trait::async_trait]
pub trait DatabaseAdapter: Send + Sync {
    /// Initialize the database
    async fn init(&self) -> Result<()>;

    /// Close the database connection
    async fn close(&self) -> Result<()>;

    /// Check if the database is ready
    async fn is_ready(&self) -> Result<bool>;

    /// Get an agent by ID
    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>>;

    /// Create an agent
    async fn create_agent(&self, agent: &Agent) -> Result<bool>;

    /// Update an agent
    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool>;

    /// Delete an agent
    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool>;

    /// Get memories
    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>>;

    /// Search memories by embedding
    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>>;

    /// Create a memory
    async fn create_memory(&self, memory: &Memory, table_name: &str) -> Result<UUID>;

    /// Update a memory
    async fn update_memory(&self, memory: &Memory) -> Result<bool>;

    /// Delete a memory
    async fn delete_memory(&self, memory_id: &UUID) -> Result<()>;

    /// Get a memory by ID
    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>>;

    /// Create a world
    async fn create_world(&self, world: &World) -> Result<UUID>;

    /// Get a world by ID
    async fn get_world(&self, id: &UUID) -> Result<Option<World>>;

    /// Create a room
    async fn create_room(&self, room: &Room) -> Result<UUID>;

    /// Get a room by ID
    async fn get_room(&self, id: &UUID) -> Result<Option<Room>>;

    /// Create an entity
    async fn create_entity(&self, entity: &Entity) -> Result<bool>;

    /// Get an entity by ID
    async fn get_entity(&self, id: &UUID) -> Result<Option<Entity>>;

    /// Add a participant to a room
    async fn add_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool>;

    /// Create a task
    async fn create_task(&self, task: &Task) -> Result<UUID>;

    /// Get a task by ID
    async fn get_task(&self, id: &UUID) -> Result<Option<Task>>;

    /// Update a task
    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()>;

    /// Delete a task
    async fn delete_task(&self, id: &UUID) -> Result<()>;
}

/// Runtime options for creating an AgentRuntime
#[derive(Default)]
pub struct RuntimeOptions {
    /// Character configuration
    pub character: Option<Character>,
    /// Agent ID (generated if not provided)
    pub agent_id: Option<UUID>,
    /// Plugins to load
    pub plugins: Vec<Plugin>,
    /// Database adapter
    pub adapter: Option<Arc<dyn DatabaseAdapter>>,
    /// Runtime settings
    pub settings: Option<RuntimeSettings>,
}

/// Event handler function type
pub type EventHandler = Arc<dyn Fn(EventPayload) -> Result<()> + Send + Sync>;

/// Model handler function type
pub type ModelHandler =
    Arc<dyn Fn(&str, serde_json::Value) -> Result<serde_json::Value> + Send + Sync>;

/// The core runtime for an elizaOS agent
pub struct AgentRuntime {
    /// Agent ID
    pub agent_id: UUID,
    /// Character configuration
    pub character: Character,
    /// Database adapter
    adapter: Option<Arc<dyn DatabaseAdapter>>,
    /// Registered actions
    actions: RwLock<Vec<Arc<dyn ActionHandler>>>,
    /// Registered providers
    providers: RwLock<Vec<Arc<dyn ProviderHandler>>>,
    /// Registered evaluators
    evaluators: RwLock<Vec<Arc<dyn EvaluatorHandler>>>,
    /// Loaded plugins
    plugins: RwLock<Vec<Plugin>>,
    /// Event handlers
    events: RwLock<HashMap<String, Vec<EventHandler>>>,
    /// Services
    services: RwLock<HashMap<String, Arc<dyn Service>>>,
    /// Runtime settings
    settings: RwLock<RuntimeSettings>,
    /// Current run ID (used in WASM mode)
    #[cfg_attr(not(feature = "wasm"), allow(dead_code))]
    current_run_id: RwLock<Option<UUID>>,
    /// Initialization promise/future resolved
    initialized: RwLock<bool>,
}

/// Service trait for long-running services
#[async_trait::async_trait]
pub trait Service: Send + Sync {
    /// Get the service type
    fn service_type(&self) -> &str;

    /// Stop the service
    async fn stop(&self) -> Result<()>;
}

impl AgentRuntime {
    /// Create a new AgentRuntime
    pub async fn new(opts: RuntimeOptions) -> Result<Self> {
        let character = opts.character.unwrap_or_default();
        let agent_id = opts.agent_id.unwrap_or_else(|| {
            // Generate deterministic UUID from character name
            UUID::new_v4()
        });

        info!("Creating AgentRuntime for agent: {}", agent_id);

        let runtime = AgentRuntime {
            agent_id,
            character,
            adapter: opts.adapter,
            actions: RwLock::new(Vec::new()),
            providers: RwLock::new(Vec::new()),
            evaluators: RwLock::new(Vec::new()),
            plugins: RwLock::new(Vec::new()),
            events: RwLock::new(HashMap::new()),
            services: RwLock::new(HashMap::new()),
            settings: RwLock::new(opts.settings.unwrap_or_default()),
            current_run_id: RwLock::new(None),
            initialized: RwLock::new(false),
        };

        // Register provided plugins
        for plugin in opts.plugins {
            // Plugin registration would happen here
            debug!("Registering plugin: {}", plugin.definition.name);
        }

        Ok(runtime)
    }

    /// Initialize the runtime
    pub async fn initialize(&self) -> Result<()> {
        info!("Initializing AgentRuntime for agent: {}", self.agent_id);

        // Initialize database adapter if present
        if let Some(adapter) = &self.adapter {
            adapter
                .init()
                .await
                .context("Failed to initialize database")?;
        }

        // Mark as initialized
        #[cfg(not(feature = "wasm"))]
        {
            let mut initialized = self.initialized.write().await;
            *initialized = true;
        }
        #[cfg(feature = "wasm")]
        {
            let mut initialized = self.initialized.write().unwrap();
            *initialized = true;
        }

        info!("AgentRuntime initialized successfully");
        Ok(())
    }

    /// Register a plugin
    pub async fn register_plugin(&self, plugin: Plugin) -> Result<()> {
        debug!("Registering plugin: {}", plugin.definition.name);

        // Register actions
        for action in &plugin.action_handlers {
            #[cfg(not(feature = "wasm"))]
            {
                let mut actions = self.actions.write().await;
                actions.push(action.clone());
            }
            #[cfg(feature = "wasm")]
            {
                let mut actions = self.actions.write().unwrap();
                actions.push(action.clone());
            }
        }

        // Register providers
        for provider in &plugin.provider_handlers {
            #[cfg(not(feature = "wasm"))]
            {
                let mut providers = self.providers.write().await;
                providers.push(provider.clone());
            }
            #[cfg(feature = "wasm")]
            {
                let mut providers = self.providers.write().unwrap();
                providers.push(provider.clone());
            }
        }

        // Register evaluators
        for evaluator in &plugin.evaluator_handlers {
            #[cfg(not(feature = "wasm"))]
            {
                let mut evaluators = self.evaluators.write().await;
                evaluators.push(evaluator.clone());
            }
            #[cfg(feature = "wasm")]
            {
                let mut evaluators = self.evaluators.write().unwrap();
                evaluators.push(evaluator.clone());
            }
        }

        // Add to plugins list
        #[cfg(not(feature = "wasm"))]
        {
            let mut plugins = self.plugins.write().await;
            plugins.push(plugin);
        }
        #[cfg(feature = "wasm")]
        {
            let mut plugins = self.plugins.write().unwrap();
            plugins.push(plugin);
        }

        Ok(())
    }

    /// Get a setting value
    pub async fn get_setting(&self, key: &str) -> Option<String> {
        #[cfg(not(feature = "wasm"))]
        {
            let settings = self.settings.read().await;
            settings.get_string(key).map(String::from)
        }
        #[cfg(feature = "wasm")]
        {
            let settings = self.settings.read().unwrap();
            settings.get_string(key).map(String::from)
        }
    }

    /// Set a setting value
    pub async fn set_setting(&self, key: &str, value: &str) {
        #[cfg(not(feature = "wasm"))]
        {
            let mut settings = self.settings.write().await;
            settings.set_string(key, value);
        }
        #[cfg(feature = "wasm")]
        {
            let mut settings = self.settings.write().unwrap();
            settings.set_string(key, value);
        }
    }

    /// Compose state for a message
    pub async fn compose_state(&self, message: &Memory) -> Result<State> {
        let mut state = State::new();

        // Get providers
        #[cfg(not(feature = "wasm"))]
        let providers = self.providers.read().await;
        #[cfg(feature = "wasm")]
        let providers = self.providers.read().unwrap();

        // Run each provider to gather context
        for provider in providers.iter() {
            let def = provider.definition();
            if def.private.unwrap_or(false) {
                continue; // Skip private providers unless explicitly called
            }

            match provider.get(message, &state).await {
                Ok(result) => {
                    // Merge provider result into state
                    if let Some(text) = result.text {
                        if !state.text.is_empty() {
                            state.text.push('\n');
                        }
                        state.text.push_str(&text);
                    }
                    if let Some(values) = result.values {
                        for (k, v) in values {
                            state.values.insert(k, v);
                        }
                    }
                }
                Err(e) => {
                    warn!("Provider {} failed: {}", def.name, e);
                }
            }
        }

        Ok(state)
    }

    /// Process actions for a message
    pub async fn process_actions(
        &self,
        message: &Memory,
        state: &State,
        options: Option<&HandlerOptions>,
    ) -> Result<Vec<ActionResult>> {
        let mut results = Vec::new();

        #[cfg(not(feature = "wasm"))]
        let actions = self.actions.read().await;
        #[cfg(feature = "wasm")]
        let actions = self.actions.read().unwrap();

        for action in actions.iter() {
            // Validate if action should run
            if !action.validate(message, Some(state)).await {
                continue;
            }

            let def = action.definition();
            debug!("Executing action: {}", def.name);

            match action.handle(message, Some(state), options).await {
                Ok(Some(result)) => {
                    results.push(result);
                }
                Ok(None) => {
                    // Action completed but returned no result
                }
                Err(e) => {
                    error!("Action {} failed: {}", def.name, e);
                    results.push(ActionResult::failure(&e.to_string()));
                }
            }
        }

        Ok(results)
    }

    /// Emit an event
    pub async fn emit_event(&self, event_type: EventType, payload: EventPayload) -> Result<()> {
        let event_name = format!("{:?}", event_type);

        #[cfg(not(feature = "wasm"))]
        let events = self.events.read().await;
        #[cfg(feature = "wasm")]
        let events = self.events.read().unwrap();

        if let Some(handlers) = events.get(&event_name) {
            for handler in handlers {
                if let Err(e) = handler(payload.clone()) {
                    error!("Event handler failed for {}: {}", event_name, e);
                }
            }
        }

        Ok(())
    }

    /// Register an event handler
    pub async fn register_event(&self, event_type: EventType, handler: EventHandler) {
        let event_name = format!("{:?}", event_type);

        #[cfg(not(feature = "wasm"))]
        {
            let mut events = self.events.write().await;
            events
                .entry(event_name)
                .or_insert_with(Vec::new)
                .push(handler);
        }
        #[cfg(feature = "wasm")]
        {
            let mut events = self.events.write().unwrap();
            events
                .entry(event_name)
                .or_insert_with(Vec::new)
                .push(handler);
        }
    }

    /// Start a new run
    pub fn start_run(&self, room_id: Option<&UUID>) -> UUID {
        let run_id = UUID::new_v4();

        #[cfg(not(feature = "wasm"))]
        {
            // In native mode, we'd need async access, but this is a sync method
            // The run_id is still tracked via the return value
        }
        #[cfg(feature = "wasm")]
        {
            let mut current = self.current_run_id.write().unwrap();
            *current = Some(run_id.clone());
        }

        debug!("Started run: {} for room: {:?}", run_id, room_id);
        run_id
    }

    /// End the current run
    pub fn end_run(&self) {
        #[cfg(not(feature = "wasm"))]
        {
            // In native mode, this would need async access
            // For now, this is a no-op in native mode
        }
        #[cfg(feature = "wasm")]
        {
            let mut current = self.current_run_id.write().unwrap();
            *current = None;
        }
    }

    /// Get the current run ID
    pub fn get_current_run_id(&self) -> Option<UUID> {
        #[cfg(not(feature = "wasm"))]
        {
            // In native mode, would need async access to read
            // For now, return None
            None
        }
        #[cfg(feature = "wasm")]
        {
            let current = self.current_run_id.read().unwrap();
            current.clone()
        }
    }

    /// Stop the runtime
    pub async fn stop(&self) -> Result<()> {
        info!("Stopping AgentRuntime for agent: {}", self.agent_id);

        // Stop all services
        #[cfg(not(feature = "wasm"))]
        {
            let services = self.services.read().await;
            for (name, service) in services.iter() {
                if let Err(e) = service.stop().await {
                    error!("Failed to stop service {}: {}", name, e);
                }
            }
        }
        #[cfg(feature = "wasm")]
        {
            let services = self.services.read().unwrap();
            for (name, service) in services.iter() {
                // Note: In WASM, we'd need to handle this differently
                debug!("Service {} would be stopped", name);
            }
        }

        // Close database adapter
        if let Some(adapter) = &self.adapter {
            adapter.close().await.context("Failed to close database")?;
        }

        info!("AgentRuntime stopped successfully");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_runtime_creation() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(Character {
                name: "TestAgent".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();

        assert_eq!(runtime.character.name, "TestAgent");
    }

    #[tokio::test]
    async fn test_runtime_settings() {
        let runtime = AgentRuntime::new(RuntimeOptions::default()).await.unwrap();

        runtime.set_setting("test_key", "test_value").await;
        let value = runtime.get_setting("test_key").await;
        assert_eq!(value, Some("test_value".to_string()));
    }

    #[tokio::test]
    async fn test_run_management() {
        let runtime = AgentRuntime::new(RuntimeOptions::default()).await.unwrap();

        let run_id = runtime.start_run(None);
        assert!(!run_id.as_str().is_empty());

        runtime.end_run();
    }
}
