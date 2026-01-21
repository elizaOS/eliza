//! Unified sync/async runtime for elizaOS
//!
//! This module provides a unified runtime that compiles to either synchronous
//! or asynchronous code based on the `sync` feature flag, using `maybe-async`.
//!
//! # Features
//!
//! - **Zero code duplication**: Single source of truth for both sync and async
//! - **100% parity**: All features available in both modes
//! - **Feature-gated**: `sync` feature enables synchronous compilation
//!
//! # Environments
//!
//! - **Async (default)**: Native servers, CLI tools, web backends (uses tokio)
//! - **Sync (`sync` feature)**: ICP canisters, embedded systems, WASI
//!
//! # Usage
//!
//! ```toml
//! # For async (default):
//! elizaos = "2.0"
//!
//! # For sync:
//! elizaos = { version = "2.0", default-features = false, features = ["sync"] }
//! ```
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos::sync_runtime::{UnifiedDatabaseAdapter, UnifiedRuntime};
//!
//! struct MyAdapter;
//!
//! impl UnifiedDatabaseAdapter for MyAdapter {
//!     // With `sync` feature: fn init(&self) -> Result<()>
//!     // Without `sync` feature: async fn init(&self) -> Result<()>
//!     #[maybe_async::maybe_async]
//!     async fn init(&self) -> Result<()> {
//!         Ok(())
//!     }
//!     // ... other methods
//! }
//! ```

use crate::types::agent::{Agent, Bio, Character, CharacterSecrets, CharacterSettings};
use crate::types::components::{
    ActionDefinition, ActionResult, EvaluatorDefinition, HandlerOptions, ProviderDefinition,
};
use crate::types::database::{GetMemoriesParams, SearchMemoriesParams};
use crate::types::environment::{Entity, Room, World};
use crate::types::events::{EventPayload, EventType};
use crate::types::memory::Memory;
use crate::types::primitives::{string_to_uuid, Content, UUID};
use crate::types::settings::{RuntimeSettings, SettingValue};
use crate::types::state::State;
use crate::types::task::Task;
use anyhow::Result;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// Conditional imports based on sync feature and native availability
// Use tokio::sync::RwLock only when not sync AND native feature is enabled
#[cfg(all(not(feature = "sync"), feature = "native"))]
use tokio::sync::RwLock;

// Use std::sync::RwLock when sync feature is enabled OR native is not available
#[cfg(any(feature = "sync", not(feature = "native")))]
use std::sync::RwLock;

// ============================================================================
// UNIFIED DATABASE ADAPTER TRAIT
// ============================================================================

/// Unified database adapter trait that compiles to sync or async.
///
/// With `sync` feature: All methods are synchronous
/// Without `sync` feature: All methods are asynchronous
///
/// # Example Implementation
///
/// ```rust,ignore
/// struct MyAdapter;
///
/// #[maybe_async::maybe_async]
/// impl UnifiedDatabaseAdapter for MyAdapter {
///     async fn init(&self) -> Result<()> {
///         // Your init code - works in both sync and async
///         Ok(())
///     }
///     // ... implement other methods
/// }
/// ```
#[maybe_async::maybe_async(?Send)]
pub trait UnifiedDatabaseAdapter: Send + Sync {
    /// Initialize the database
    async fn init(&self) -> Result<()>;

    /// Close the database connection
    async fn close(&self) -> Result<()>;

    /// Check if the database is ready
    async fn is_ready(&self) -> Result<bool>;

    // ----- Agent Operations -----

    /// Get an agent by ID
    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>>;

    /// Create an agent
    async fn create_agent(&self, agent: &Agent) -> Result<bool>;

    /// Update an agent
    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool>;

    /// Delete an agent
    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool>;

    // ----- Memory Operations -----

    /// Get memories with filtering
    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>>;

    /// Search memories by embedding (vector similarity)
    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>>;

    /// Create a memory
    async fn create_memory(&self, memory: &Memory, table_name: &str) -> Result<UUID>;

    /// Update a memory
    async fn update_memory(&self, memory: &Memory) -> Result<bool>;

    /// Delete a memory
    async fn delete_memory(&self, memory_id: &UUID) -> Result<()>;

    /// Get a memory by ID
    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>>;

    // ----- World Operations -----

    /// Create a world
    async fn create_world(&self, world: &World) -> Result<UUID>;

    /// Get a world by ID
    async fn get_world(&self, id: &UUID) -> Result<Option<World>>;

    // ----- Room Operations -----

    /// Create a room
    async fn create_room(&self, room: &Room) -> Result<UUID>;

    /// Get a room by ID
    async fn get_room(&self, id: &UUID) -> Result<Option<Room>>;

    /// Delete a room and associated data
    async fn delete_room(&self, room_id: &UUID) -> Result<()> {
        let _ = room_id;
        Ok(())
    }

    /// Get rooms by IDs
    async fn get_rooms_by_ids(&self, room_ids: &[UUID]) -> Result<Vec<Room>> {
        let mut rooms = Vec::new();
        for id in room_ids {
            if let Some(room) = self.get_room(id).await? {
                rooms.push(room);
            }
        }
        Ok(rooms)
    }

    // ----- Entity Operations -----

    /// Create an entity
    async fn create_entity(&self, entity: &Entity) -> Result<bool>;

    /// Get an entity by ID
    async fn get_entity(&self, id: &UUID) -> Result<Option<Entity>>;

    /// Update an entity
    async fn update_entity(&self, id: &UUID, entity: &Entity) -> Result<bool> {
        let _ = (id, entity);
        Ok(false)
    }

    /// Delete an entity
    async fn delete_entity(&self, id: &UUID) -> Result<bool> {
        let _ = id;
        Ok(false)
    }

    // ----- Participant Operations -----

    /// Add a participant to a room
    async fn add_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool>;

    /// Remove a participant from a room
    async fn remove_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool> {
        let _ = (entity_id, room_id);
        Ok(false)
    }

    /// Get participants in a room
    async fn get_participants(&self, room_id: &UUID) -> Result<Vec<Entity>> {
        let _ = room_id;
        Ok(Vec::new())
    }

    // ----- Task Operations -----

    /// Create a task
    async fn create_task(&self, task: &Task) -> Result<UUID>;

    /// Get a task by ID
    async fn get_task(&self, id: &UUID) -> Result<Option<Task>>;

    /// Update a task
    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()>;

    /// Delete a task
    async fn delete_task(&self, id: &UUID) -> Result<()>;

    /// Get tasks by status
    async fn get_tasks_by_status(&self, status: &str) -> Result<Vec<Task>> {
        let _ = status;
        Ok(Vec::new())
    }

    // ----- Cache Operations -----

    /// Get a cached value
    async fn get_cache(&self, key: &str) -> Result<Option<serde_json::Value>> {
        let _ = key;
        Ok(None)
    }

    /// Set a cached value
    async fn set_cache(&self, key: &str, value: serde_json::Value) -> Result<bool> {
        let _ = (key, value);
        Ok(false)
    }

    /// Delete a cached value
    async fn delete_cache(&self, key: &str) -> Result<bool> {
        let _ = key;
        Ok(false)
    }

    // ----- Relationship Operations -----

    /// Create a relationship between entities
    async fn create_relationship(
        &self,
        entity_a: &UUID,
        entity_b: &UUID,
        relationship_type: &str,
    ) -> Result<bool> {
        let _ = (entity_a, entity_b, relationship_type);
        Ok(false)
    }

    /// Get relationships for an entity
    async fn get_relationships(
        &self,
        entity_id: &UUID,
    ) -> Result<Vec<crate::types::environment::Relationship>> {
        let _ = entity_id;
        Ok(Vec::new())
    }
}

// ============================================================================
// UNIFIED HANDLER TRAITS
// ============================================================================

/// Provider result from unified provider handler
#[derive(Debug, Clone, Default)]
pub struct UnifiedProviderResult {
    /// Text to add to state
    pub text: Option<String>,
    /// Values to merge into state
    pub values: Option<HashMap<String, serde_json::Value>>,
}

/// Unified provider handler that compiles to sync or async
#[maybe_async::maybe_async(?Send)]
pub trait UnifiedProviderHandler: Send + Sync {
    /// Get provider definition
    fn definition(&self) -> ProviderDefinition;

    /// Execute the provider
    async fn get(&self, message: &Memory, state: &State) -> Result<UnifiedProviderResult>;
}

/// Unified action handler that compiles to sync or async
#[maybe_async::maybe_async(?Send)]
pub trait UnifiedActionHandler: Send + Sync {
    /// Get action definition
    fn definition(&self) -> ActionDefinition;

    /// Validate if action should run
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;

    /// Execute the action
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>>;
}

/// Unified evaluator handler that compiles to sync or async
#[maybe_async::maybe_async(?Send)]
pub trait UnifiedEvaluatorHandler: Send + Sync {
    /// Get evaluator definition
    fn definition(&self) -> EvaluatorDefinition;

    /// Validate if evaluator should run
    async fn validate(&self, message: &Memory, state: Option<&State>) -> bool;

    /// Execute the evaluator
    async fn handle(
        &self,
        message: &Memory,
        state: Option<&State>,
        options: Option<&HandlerOptions>,
    ) -> Result<Option<ActionResult>>;
}

// ============================================================================
// UNIFIED SERVICE TRAIT
// ============================================================================

/// Unified service trait for long-running services.
#[maybe_async::maybe_async(?Send)]
pub trait UnifiedService: Send + Sync {
    /// Get the service type identifier
    fn service_type(&self) -> &str;

    /// Stop the service
    async fn stop(&self) -> Result<()>;

    /// Check if the service is running
    fn is_running(&self) -> bool {
        true
    }
}

// ============================================================================
// MODEL HANDLER TYPES
// ============================================================================

/// Model handler type for sync builds
#[cfg(any(feature = "sync", not(feature = "native")))]
pub type UnifiedModelHandler = Box<dyn Fn(serde_json::Value) -> Result<String> + Send + Sync>;

/// Model handler type for async builds
#[cfg(all(not(feature = "sync"), feature = "native"))]
pub type UnifiedModelHandler = Box<
    dyn Fn(
            serde_json::Value,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>
        + Send
        + Sync,
>;

// ============================================================================
// UNIFIED AGENT RUNTIME
// ============================================================================

/// Unified agent runtime that works in both sync and async modes.
///
/// This runtime provides full parity between sync and async environments:
/// - Same API surface
/// - Same features (plugins, providers, actions, evaluators)
/// - Same message processing flow
pub struct UnifiedRuntime<A: UnifiedDatabaseAdapter + 'static> {
    /// Agent ID
    pub agent_id: UUID,
    /// Character configuration
    character: RwLock<Character>,
    /// Database adapter
    adapter: Option<Arc<A>>,
    /// Registered actions (using unified trait)
    actions: RwLock<Vec<Arc<dyn UnifiedActionHandler>>>,
    /// Registered providers (using unified trait)
    providers: RwLock<Vec<Arc<dyn UnifiedProviderHandler>>>,
    /// Registered evaluators (using unified trait)
    evaluators: RwLock<Vec<Arc<dyn UnifiedEvaluatorHandler>>>,
    /// Event handlers
    events: RwLock<HashMap<String, Vec<EventHandler>>>,
    /// Model handlers
    model_handlers: RwLock<HashMap<String, UnifiedModelHandler>>,
    /// Runtime settings
    settings: RwLock<RuntimeSettings>,
    /// Current run ID
    current_run_id: Mutex<Option<UUID>>,
    /// Current room ID
    current_room_id: Mutex<Option<UUID>>,
    /// Initialization flag
    initialized: RwLock<bool>,
    /// Action planning enabled
    action_planning: bool,
    /// Check should respond enabled
    check_should_respond: bool,
}

/// Event handler function type
pub type EventHandler = Arc<dyn Fn(EventPayload) -> Result<()> + Send + Sync>;

/// Runtime options for unified runtime
pub struct UnifiedRuntimeOptions<A: UnifiedDatabaseAdapter + 'static> {
    /// Character configuration
    pub character: Option<Character>,
    /// Agent ID (generated if not provided)
    pub agent_id: Option<UUID>,
    /// Database adapter
    pub adapter: Option<Arc<A>>,
    /// Runtime settings
    pub settings: Option<RuntimeSettings>,
    /// Actions to register
    pub actions: Vec<Arc<dyn UnifiedActionHandler>>,
    /// Providers to register
    pub providers: Vec<Arc<dyn UnifiedProviderHandler>>,
    /// Evaluators to register
    pub evaluators: Vec<Arc<dyn UnifiedEvaluatorHandler>>,
    /// Enable action planning (default: true)
    pub action_planning: Option<bool>,
    /// Enable should respond check (default: true)
    pub check_should_respond: Option<bool>,
}

impl<A: UnifiedDatabaseAdapter + 'static> Default for UnifiedRuntimeOptions<A> {
    fn default() -> Self {
        Self {
            character: None,
            agent_id: None,
            adapter: None,
            settings: None,
            actions: Vec::new(),
            providers: Vec::new(),
            evaluators: Vec::new(),
            action_planning: Some(true),
            check_should_respond: Some(true),
        }
    }
}

impl<A: UnifiedDatabaseAdapter + 'static> UnifiedRuntime<A> {
    /// Create a new unified runtime
    pub fn new(opts: UnifiedRuntimeOptions<A>) -> Result<Self> {
        let character = opts.character.unwrap_or_else(|| Character {
            name: "Agent".to_string(),
            bio: Bio::Single("An AI assistant".to_string()),
            ..Default::default()
        });

        let agent_id = character
            .id
            .clone()
            .or(opts.agent_id)
            .unwrap_or_else(|| string_to_uuid(&character.name));

        Ok(Self {
            agent_id,
            character: RwLock::new(character),
            adapter: opts.adapter,
            actions: RwLock::new(opts.actions),
            providers: RwLock::new(opts.providers),
            evaluators: RwLock::new(opts.evaluators),
            events: RwLock::new(HashMap::new()),
            model_handlers: RwLock::new(HashMap::new()),
            settings: RwLock::new(opts.settings.unwrap_or_default()),
            current_run_id: Mutex::new(None),
            current_room_id: Mutex::new(None),
            initialized: RwLock::new(false),
            action_planning: opts.action_planning.unwrap_or(true),
            check_should_respond: opts.check_should_respond.unwrap_or(true),
        })
    }

    /// Initialize the runtime
    #[maybe_async::maybe_async]
    pub async fn initialize(&self) -> Result<()> {
        // Initialize database adapter
        if let Some(adapter) = &self.adapter {
            adapter.init().await?;
        }

        // Mark as initialized
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            let mut init = self.initialized.write().await;
            *init = true;
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            let mut init = self.initialized.write().expect("lock poisoned");
            *init = true;
        }

        Ok(())
    }

    /// Check if initialized
    pub fn is_initialized(&self) -> bool {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            // For async, we need to use try_read or block
            self.initialized
                .try_read()
                .map(|guard| *guard)
                .unwrap_or(false)
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            *self.initialized.read().expect("lock poisoned")
        }
    }

    /// Get the database adapter
    pub fn get_adapter(&self) -> Option<&Arc<A>> {
        self.adapter.as_ref()
    }

    /// Register a model handler
    pub fn register_model(&self, model_type: &str, handler: UnifiedModelHandler) {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            if let Ok(mut handlers) = self.model_handlers.try_write() {
                handlers.insert(model_type.to_string(), handler);
            }
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            let mut handlers = self.model_handlers.write().expect("lock poisoned");
            handlers.insert(model_type.to_string(), handler);
        }
    }

    /// Use a model to generate text
    #[maybe_async::maybe_async]
    pub async fn use_model(&self, model_type: &str, params: serde_json::Value) -> Result<String> {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            let handlers = self.model_handlers.read().await;
            let handler = handlers
                .get(model_type)
                .ok_or_else(|| anyhow::anyhow!("No handler for model: {}", model_type))?;
            handler(params).await
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            let handlers = self.model_handlers.read().expect("lock poisoned");
            let handler = handlers
                .get(model_type)
                .ok_or_else(|| anyhow::anyhow!("No handler for model: {}", model_type))?;
            handler(params)
        }
    }

    /// Get a setting value
    #[maybe_async::maybe_async]
    pub async fn get_setting(&self, key: &str) -> Option<SettingValue> {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        let character = self.character.read().await;
        #[cfg(any(feature = "sync", not(feature = "native")))]
        let character = self.character.read().expect("lock poisoned");

        // Check secrets first
        if let Some(secrets) = &character.secrets {
            if let Some(v) = secrets.values.get(key) {
                return json_to_setting(v);
            }
        }

        // Check settings
        if let Some(settings) = &character.settings {
            if let Some(v) = settings.values.get(key) {
                return json_to_setting(v);
            }
        }

        // Check runtime settings
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        let settings = self.settings.read().await;
        #[cfg(any(feature = "sync", not(feature = "native")))]
        let settings = self.settings.read().expect("lock poisoned");

        settings.values.get(key).cloned()
    }

    /// Set a setting value
    #[maybe_async::maybe_async]
    pub async fn set_setting(&self, key: &str, value: SettingValue, secret: bool) {
        if secret {
            #[cfg(all(not(feature = "sync"), feature = "native"))]
            let mut character = self.character.write().await;
            #[cfg(any(feature = "sync", not(feature = "native")))]
            let mut character = self.character.write().expect("lock poisoned");

            if character.secrets.is_none() {
                character.secrets = Some(CharacterSecrets::default());
            }
            if let Some(secrets) = &mut character.secrets {
                secrets
                    .values
                    .insert(key.to_string(), setting_to_json(&value));
            }
        } else {
            #[cfg(all(not(feature = "sync"), feature = "native"))]
            let mut character = self.character.write().await;
            #[cfg(any(feature = "sync", not(feature = "native")))]
            let mut character = self.character.write().expect("lock poisoned");

            if character.settings.is_none() {
                character.settings = Some(CharacterSettings::default());
            }
            if let Some(settings) = &mut character.settings {
                settings
                    .values
                    .insert(key.to_string(), setting_to_json(&value));
            }
        }
    }

    /// Compose state from providers
    #[maybe_async::maybe_async]
    pub async fn compose_state(&self, message: &Memory) -> Result<State> {
        let mut state = State::new();

        // Get providers
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        let providers: Vec<_> = self.providers.read().await.iter().cloned().collect();
        #[cfg(any(feature = "sync", not(feature = "native")))]
        let providers: Vec<_> = self
            .providers
            .read()
            .expect("lock poisoned")
            .iter()
            .cloned()
            .collect();

        // Run each provider
        for provider in providers.iter() {
            let def = provider.definition();
            if def.private.unwrap_or(false) {
                continue;
            }

            match provider.get(message, &state).await {
                Ok(result) => {
                    if let Some(text) = result.text {
                        if !state.text.is_empty() {
                            state.text.push('\n');
                        }
                        state.text.push_str(&text);
                    }
                }
                Err(_) => continue,
            }
        }

        // Add message content to state
        if let Some(text) = &message.content.text {
            if !state.text.is_empty() {
                state.text.push_str("\n\n");
            }
            state
                .text
                .push_str(&format!("# Current Message\nUser: {}", text));
        }

        Ok(state)
    }

    /// Register an action handler
    pub fn register_action(&self, action: Arc<dyn UnifiedActionHandler>) {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            if let Ok(mut actions) = self.actions.try_write() {
                actions.push(action);
            }
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.actions.write().expect("lock poisoned").push(action);
        }
    }

    /// Register a provider handler
    pub fn register_provider(&self, provider: Arc<dyn UnifiedProviderHandler>) {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            if let Ok(mut providers) = self.providers.try_write() {
                providers.push(provider);
            }
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.providers
                .write()
                .expect("lock poisoned")
                .push(provider);
        }
    }

    /// Register an evaluator handler
    pub fn register_evaluator(&self, evaluator: Arc<dyn UnifiedEvaluatorHandler>) {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            if let Ok(mut evaluators) = self.evaluators.try_write() {
                evaluators.push(evaluator);
            }
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.evaluators
                .write()
                .expect("lock poisoned")
                .push(evaluator);
        }
    }

    /// List action definitions
    pub fn list_action_definitions(&self) -> Vec<ActionDefinition> {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            self.actions
                .try_read()
                .map(|actions| actions.iter().map(|a| a.definition()).collect())
                .unwrap_or_default()
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.actions
                .read()
                .expect("lock poisoned")
                .iter()
                .map(|a| a.definition())
                .collect()
        }
    }

    /// List provider definitions
    pub fn list_provider_definitions(&self) -> Vec<ProviderDefinition> {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            self.providers
                .try_read()
                .map(|providers| providers.iter().map(|p| p.definition()).collect())
                .unwrap_or_default()
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.providers
                .read()
                .expect("lock poisoned")
                .iter()
                .map(|p| p.definition())
                .collect()
        }
    }

    /// List evaluator definitions
    pub fn list_evaluator_definitions(&self) -> Vec<EvaluatorDefinition> {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            self.evaluators
                .try_read()
                .map(|evaluators| evaluators.iter().map(|e| e.definition()).collect())
                .unwrap_or_default()
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.evaluators
                .read()
                .expect("lock poisoned")
                .iter()
                .map(|e| e.definition())
                .collect()
        }
    }

    /// Process actions for a message
    #[maybe_async::maybe_async]
    pub async fn process_actions(
        &self,
        message: &Memory,
        state: &State,
        options: Option<&HandlerOptions>,
    ) -> Result<Vec<ActionResult>> {
        let mut results = Vec::new();

        #[cfg(all(not(feature = "sync"), feature = "native"))]
        let actions: Vec<Arc<dyn UnifiedActionHandler>> =
            self.actions.read().await.iter().cloned().collect();
        #[cfg(any(feature = "sync", not(feature = "native")))]
        let actions: Vec<Arc<dyn UnifiedActionHandler>> = self
            .actions
            .read()
            .expect("lock poisoned")
            .iter()
            .cloned()
            .collect();

        // Limit to single action if action planning disabled
        let actions_to_run: Vec<_> = if self.action_planning {
            actions
        } else if !actions.is_empty() {
            vec![actions.into_iter().next().unwrap()]
        } else {
            actions
        };

        for action in actions_to_run.iter() {
            let should_run = action.validate(message, Some(state)).await;
            if !should_run {
                continue;
            }

            match action.handle(message, Some(state), options).await {
                Ok(Some(result)) => results.push(result),
                Ok(None) => {}
                Err(e) => results.push(ActionResult::failure(&e.to_string())),
            }
        }

        Ok(results)
    }

    /// Run evaluators
    #[maybe_async::maybe_async]
    pub async fn evaluate_message(
        &self,
        message: &Memory,
        state: &State,
    ) -> Result<Vec<ActionResult>> {
        let mut results = Vec::new();

        #[cfg(all(not(feature = "sync"), feature = "native"))]
        let evaluators: Vec<Arc<dyn UnifiedEvaluatorHandler>> =
            self.evaluators.read().await.iter().cloned().collect();
        #[cfg(any(feature = "sync", not(feature = "native")))]
        let evaluators: Vec<Arc<dyn UnifiedEvaluatorHandler>> = self
            .evaluators
            .read()
            .expect("lock poisoned")
            .iter()
            .cloned()
            .collect();

        for evaluator in evaluators.iter() {
            let should_run = evaluator.validate(message, Some(state)).await;
            if !should_run {
                continue;
            }

            match evaluator.handle(message, Some(state), None).await {
                Ok(Some(result)) => results.push(result),
                Ok(None) => {}
                Err(e) => results.push(ActionResult::failure(&e.to_string())),
            }
        }

        Ok(results)
    }

    /// Register an event handler
    #[maybe_async::maybe_async]
    pub async fn register_event(&self, event_type: EventType, handler: EventHandler) {
        let event_name = format!("{:?}", event_type);

        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            let mut events = self.events.write().await;
            events.entry(event_name).or_default().push(handler);
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            let mut events = self.events.write().expect("lock poisoned");
            events.entry(event_name).or_default().push(handler);
        }
    }

    /// Emit an event
    #[maybe_async::maybe_async]
    pub async fn emit_event(&self, event_type: EventType, payload: EventPayload) -> Result<()> {
        let event_name = format!("{:?}", event_type);

        #[cfg(all(not(feature = "sync"), feature = "native"))]
        let events = self.events.read().await;
        #[cfg(any(feature = "sync", not(feature = "native")))]
        let events = self.events.read().expect("lock poisoned");

        if let Some(handlers) = events.get(&event_name) {
            for handler in handlers {
                let _ = handler(payload.clone());
            }
        }

        Ok(())
    }

    /// Start a run
    pub fn start_run(&self, room_id: Option<&UUID>) -> UUID {
        let run_id = UUID::new_v4();
        {
            let mut current = self.current_run_id.lock().expect("lock poisoned");
            *current = Some(run_id.clone());
        }
        {
            let mut current_room = self.current_room_id.lock().expect("lock poisoned");
            *current_room = room_id.cloned();
        }
        run_id
    }

    /// End a run
    pub fn end_run(&self) {
        {
            let mut current = self.current_run_id.lock().expect("lock poisoned");
            *current = None;
        }
        {
            let mut current_room = self.current_room_id.lock().expect("lock poisoned");
            *current_room = None;
        }
    }

    /// Get current run ID
    pub fn get_current_run_id(&self) -> Option<UUID> {
        self.current_run_id.lock().expect("lock poisoned").clone()
    }

    /// Get current room ID
    pub fn get_current_room_id(&self) -> Option<UUID> {
        self.current_room_id.lock().expect("lock poisoned").clone()
    }

    /// Get a message service
    pub fn message_service(&self) -> UnifiedMessageService {
        UnifiedMessageService {
            _check_should_respond: self.check_should_respond,
        }
    }

    /// Stop the runtime
    #[maybe_async::maybe_async]
    pub async fn stop(&self) -> Result<()> {
        if let Some(adapter) = &self.adapter {
            adapter.close().await?;
        }
        Ok(())
    }

    /// Get character name
    pub fn character_name(&self) -> String {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            self.character
                .try_read()
                .map(|c| c.name.clone())
                .unwrap_or_else(|_| "Agent".to_string())
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.character.read().expect("lock poisoned").name.clone()
        }
    }

    /// Get character system prompt
    pub fn character_system(&self) -> Option<String> {
        #[cfg(all(not(feature = "sync"), feature = "native"))]
        {
            self.character
                .try_read()
                .ok()
                .and_then(|c| c.system.clone())
        }
        #[cfg(any(feature = "sync", not(feature = "native")))]
        {
            self.character.read().expect("lock poisoned").system.clone()
        }
    }
}

// ============================================================================
// UNIFIED MESSAGE SERVICE
// ============================================================================

/// Options for message processing
#[derive(Default, Clone)]
pub struct UnifiedMessageProcessingOptions {
    /// Maximum retries
    pub max_retries: Option<u32>,
    /// Timeout in milliseconds
    pub timeout_ms: Option<u64>,
}

/// Result of message processing
#[derive(Debug, Clone)]
pub struct UnifiedMessageProcessingResult {
    /// Whether the agent responded
    pub did_respond: bool,
    /// Response content
    pub response_content: Option<Content>,
    /// Response messages
    pub response_messages: Vec<Memory>,
    /// Final state
    pub state: State,
}

impl Default for UnifiedMessageProcessingResult {
    fn default() -> Self {
        Self {
            did_respond: false,
            response_content: None,
            response_messages: Vec::new(),
            state: State::new(),
        }
    }
}

/// Unified message service
pub struct UnifiedMessageService {
    /// Whether to check shouldRespond before processing (reserved for future use)
    _check_should_respond: bool,
}

impl UnifiedMessageService {
    /// Handle a message
    #[maybe_async::maybe_async]
    pub async fn handle_message<A: UnifiedDatabaseAdapter + 'static>(
        &self,
        runtime: &UnifiedRuntime<A>,
        message: &mut Memory,
        _options: Option<UnifiedMessageProcessingOptions>,
    ) -> Result<UnifiedMessageProcessingResult> {
        // Start run
        let _run_id = runtime.start_run(Some(&message.room_id));

        // Save incoming message
        if let Some(adapter) = runtime.get_adapter() {
            if message.id.is_none() {
                message.id = Some(UUID::new_v4());
            }
            let message_id = message.id.as_ref().unwrap();
            if adapter.get_memory_by_id(message_id).await?.is_none() {
                adapter.create_memory(message, "messages").await?;
            }
        }

        // Compose state
        let state = runtime.compose_state(message).await?;

        // Get character info
        let character_name = runtime.character_name();
        let system_prompt = runtime.character_system();

        // Build prompt
        let _user_text = message.content.text.as_deref().unwrap_or("");
        let prompt = format!(
            "You are {}.\n\n{}\n\n# Task\nRespond to the user's message naturally and helpfully.",
            character_name, state.text
        );

        // Generate response
        let response_text = runtime
            .use_model(
                "TEXT_LARGE",
                serde_json::json!({
                    "prompt": prompt,
                    "system": system_prompt,
                    "temperature": 0.7
                }),
            )
            .await?;

        // Create response content
        let response_content = Content {
            text: Some(response_text.clone()),
            ..Default::default()
        };

        // Create response memory
        let response_id = UUID::new_v4();
        let response_memory = Memory {
            id: Some(response_id.clone()),
            entity_id: runtime.agent_id.clone(),
            agent_id: Some(runtime.agent_id.clone()),
            room_id: message.room_id.clone(),
            content: response_content.clone(),
            created_at: Some(now_millis()),
            embedding: None,
            world_id: None,
            unique: Some(true),
            similarity: None,
            metadata: None,
        };

        // Save response
        if let Some(adapter) = runtime.get_adapter() {
            adapter.create_memory(&response_memory, "messages").await?;
        }

        // Run evaluators
        let _ = runtime.evaluate_message(message, &state).await?;

        runtime.end_run();

        Ok(UnifiedMessageProcessingResult {
            did_respond: true,
            response_content: Some(response_content),
            response_messages: vec![response_memory],
            state,
        })
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn json_to_setting(value: &serde_json::Value) -> Option<SettingValue> {
    match value {
        serde_json::Value::String(s) => Some(SettingValue::String(s.clone())),
        serde_json::Value::Bool(b) => Some(SettingValue::Bool(*b)),
        serde_json::Value::Number(n) => n.as_f64().map(SettingValue::Number),
        serde_json::Value::Null => Some(SettingValue::Null),
        _ => None,
    }
}

fn setting_to_json(value: &SettingValue) -> serde_json::Value {
    match value {
        SettingValue::String(s) => serde_json::Value::String(s.clone()),
        SettingValue::Bool(b) => serde_json::Value::Bool(*b),
        SettingValue::Number(n) => serde_json::Number::from_f64(*n)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        SettingValue::Null => serde_json::Value::Null,
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================================================================
// BACKWARD COMPATIBILITY - SYNC-ONLY ALIASES
// ============================================================================

/// Alias for backward compatibility with sync-only code
pub type DatabaseAdapterSync = dyn UnifiedDatabaseAdapter;

/// Alias for backward compatibility
pub type SyncAgentRuntime<A> = UnifiedRuntime<A>;

/// Alias for backward compatibility
pub type SyncMessageService = UnifiedMessageService;

/// Alias for backward compatibility
pub type SyncMessageProcessingResult = UnifiedMessageProcessingResult;

/// Alias for backward compatibility
pub type SyncModelHandler = UnifiedModelHandler;

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Mock database adapter for testing
    struct MockAdapter {
        ready: std::sync::atomic::AtomicBool,
    }

    impl MockAdapter {
        fn new() -> Self {
            Self {
                ready: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }

    #[maybe_async::maybe_async(?Send)]
    impl UnifiedDatabaseAdapter for MockAdapter {
        async fn init(&self) -> Result<()> {
            self.ready.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        async fn close(&self) -> Result<()> {
            self.ready.store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        async fn is_ready(&self) -> Result<bool> {
            Ok(self.ready.load(std::sync::atomic::Ordering::SeqCst))
        }

        async fn get_agent(&self, _id: &UUID) -> Result<Option<Agent>> {
            Ok(None)
        }

        async fn create_agent(&self, _agent: &Agent) -> Result<bool> {
            Ok(true)
        }

        async fn update_agent(&self, _id: &UUID, _agent: &Agent) -> Result<bool> {
            Ok(true)
        }

        async fn delete_agent(&self, _id: &UUID) -> Result<bool> {
            Ok(true)
        }

        async fn get_memories(&self, _params: GetMemoriesParams) -> Result<Vec<Memory>> {
            Ok(Vec::new())
        }

        async fn search_memories(&self, _params: SearchMemoriesParams) -> Result<Vec<Memory>> {
            Ok(Vec::new())
        }

        async fn create_memory(&self, memory: &Memory, _table: &str) -> Result<UUID> {
            Ok(memory.id.clone().unwrap_or_else(UUID::new_v4))
        }

        async fn update_memory(&self, _memory: &Memory) -> Result<bool> {
            Ok(true)
        }

        async fn delete_memory(&self, _id: &UUID) -> Result<()> {
            Ok(())
        }

        async fn get_memory_by_id(&self, _id: &UUID) -> Result<Option<Memory>> {
            Ok(None)
        }

        async fn create_world(&self, _world: &World) -> Result<UUID> {
            Ok(UUID::new_v4())
        }

        async fn get_world(&self, _id: &UUID) -> Result<Option<World>> {
            Ok(None)
        }

        async fn create_room(&self, _room: &Room) -> Result<UUID> {
            Ok(UUID::new_v4())
        }

        async fn get_room(&self, _id: &UUID) -> Result<Option<Room>> {
            Ok(None)
        }

        async fn create_entity(&self, _entity: &Entity) -> Result<bool> {
            Ok(true)
        }

        async fn get_entity(&self, _id: &UUID) -> Result<Option<Entity>> {
            Ok(None)
        }

        async fn add_participant(&self, _entity_id: &UUID, _room_id: &UUID) -> Result<bool> {
            Ok(true)
        }

        async fn create_task(&self, _task: &Task) -> Result<UUID> {
            Ok(UUID::new_v4())
        }

        async fn get_task(&self, _id: &UUID) -> Result<Option<Task>> {
            Ok(None)
        }

        async fn update_task(&self, _id: &UUID, _task: &Task) -> Result<()> {
            Ok(())
        }

        async fn delete_task(&self, _id: &UUID) -> Result<()> {
            Ok(())
        }
    }

    // ========== SYNC TESTS ==========
    #[cfg(any(feature = "sync", not(feature = "native")))]
    mod sync_tests {
        use super::*;

        #[test]
        fn test_runtime_creation() {
            let character = Character {
                name: "TestAgent".to_string(),
                bio: Bio::Single("Test bio".to_string()),
                ..Default::default()
            };

            let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
                character: Some(character),
                adapter: Some(Arc::new(MockAdapter::new())),
                ..Default::default()
            })
            .expect("Failed to create runtime");

            assert_eq!(runtime.character_name(), "TestAgent");
        }

        #[test]
        fn test_runtime_initialization() {
            let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
                adapter: Some(Arc::new(MockAdapter::new())),
                ..Default::default()
            })
            .expect("Failed to create runtime");

            assert!(!runtime.is_initialized());
            runtime.initialize().expect("Failed to initialize");
            assert!(runtime.is_initialized());
        }

        #[test]
        fn test_model_handler_sync() {
            let runtime = UnifiedRuntime::<MockAdapter>::new(UnifiedRuntimeOptions::default())
                .expect("Failed to create runtime");

            runtime.register_model(
                "TEXT_LARGE",
                Box::new(|_params| Ok("Sync response".to_string())),
            );

            let result = runtime
                .use_model("TEXT_LARGE", serde_json::json!({}))
                .expect("Failed to use model");

            assert_eq!(result, "Sync response");
        }

        #[test]
        fn test_settings_sync() {
            let runtime = UnifiedRuntime::<MockAdapter>::new(UnifiedRuntimeOptions::default())
                .expect("Failed to create runtime");

            runtime.set_setting(
                "TEST_KEY",
                SettingValue::String("test_value".to_string()),
                false,
            );
            let value = runtime.get_setting("TEST_KEY");

            assert_eq!(value, Some(SettingValue::String("test_value".to_string())));
        }

        #[test]
        fn test_run_management_sync() {
            let runtime = UnifiedRuntime::<MockAdapter>::new(UnifiedRuntimeOptions::default())
                .expect("Failed to create runtime");

            assert!(runtime.get_current_run_id().is_none());

            let room_id = UUID::new_v4();
            let run_id = runtime.start_run(Some(&room_id));

            assert!(runtime.get_current_run_id().is_some());
            assert_eq!(runtime.get_current_run_id(), Some(run_id));
            assert_eq!(runtime.get_current_room_id(), Some(room_id));

            runtime.end_run();

            assert!(runtime.get_current_run_id().is_none());
            assert!(runtime.get_current_room_id().is_none());
        }

        #[test]
        fn test_message_service_sync() {
            let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
                adapter: Some(Arc::new(MockAdapter::new())),
                ..Default::default()
            })
            .expect("Failed to create runtime");

            runtime.register_model(
                "TEXT_LARGE",
                Box::new(|_| Ok("Hello from sync!".to_string())),
            );

            runtime.initialize().expect("Failed to initialize");

            let service = runtime.message_service();
            let mut message = Memory::message(UUID::new_v4(), UUID::new_v4(), "Test message");

            let result = service
                .handle_message(&runtime, &mut message, None)
                .expect("Failed to handle message");

            assert!(result.did_respond);
            assert!(result.response_content.is_some());
            assert_eq!(
                result.response_content.as_ref().unwrap().text,
                Some("Hello from sync!".to_string())
            );
        }

        #[test]
        fn test_compose_state_sync() {
            let runtime = UnifiedRuntime::<MockAdapter>::new(UnifiedRuntimeOptions::default())
                .expect("Failed to create runtime");

            let message = Memory::message(UUID::new_v4(), UUID::new_v4(), "Hello world");
            let state = runtime
                .compose_state(&message)
                .expect("Failed to compose state");

            assert!(state.text.contains("Hello world"));
        }

        #[test]
        fn test_database_adapter_sync() {
            let adapter = MockAdapter::new();

            assert!(!adapter.is_ready().expect("is_ready failed"));
            adapter.init().expect("init failed");
            assert!(adapter.is_ready().expect("is_ready failed"));
            adapter.close().expect("close failed");
            assert!(!adapter.is_ready().expect("is_ready failed"));
        }
    }

    // ========== ASYNC TESTS ==========
    #[cfg(all(not(feature = "sync"), feature = "native"))]
    mod async_tests {
        use super::*;

        #[tokio::test]
        async fn test_runtime_creation_async() {
            let character = Character {
                name: "AsyncAgent".to_string(),
                bio: Bio::Single("Async test bio".to_string()),
                ..Default::default()
            };

            let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
                character: Some(character),
                adapter: Some(Arc::new(MockAdapter::new())),
                ..Default::default()
            })
            .expect("Failed to create runtime");

            assert_eq!(runtime.character_name(), "AsyncAgent");
        }

        #[tokio::test]
        async fn test_runtime_initialization_async() {
            let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
                adapter: Some(Arc::new(MockAdapter::new())),
                ..Default::default()
            })
            .expect("Failed to create runtime");

            runtime.initialize().await.expect("Failed to initialize");
            assert!(runtime.is_initialized());
        }

        #[tokio::test]
        async fn test_model_handler_async() {
            let runtime = UnifiedRuntime::<MockAdapter>::new(UnifiedRuntimeOptions::default())
                .expect("Failed to create runtime");

            runtime.register_model(
                "TEXT_LARGE",
                Box::new(|_params| Box::pin(async { Ok("Async response".to_string()) })),
            );

            let result = runtime
                .use_model("TEXT_LARGE", serde_json::json!({}))
                .await
                .expect("Failed to use model");

            assert_eq!(result, "Async response");
        }

        #[tokio::test]
        async fn test_settings_async() {
            let runtime = UnifiedRuntime::<MockAdapter>::new(UnifiedRuntimeOptions::default())
                .expect("Failed to create runtime");

            runtime
                .set_setting(
                    "ASYNC_KEY",
                    SettingValue::String("async_value".to_string()),
                    false,
                )
                .await;

            let value = runtime.get_setting("ASYNC_KEY").await;
            assert_eq!(value, Some(SettingValue::String("async_value".to_string())));
        }

        #[tokio::test]
        async fn test_message_service_async() {
            let runtime = UnifiedRuntime::new(UnifiedRuntimeOptions {
                adapter: Some(Arc::new(MockAdapter::new())),
                ..Default::default()
            })
            .expect("Failed to create runtime");

            runtime.register_model(
                "TEXT_LARGE",
                Box::new(|_| Box::pin(async { Ok("Hello from async!".to_string()) })),
            );

            runtime.initialize().await.expect("Failed to initialize");

            let service = runtime.message_service();
            let mut message = Memory::message(UUID::new_v4(), UUID::new_v4(), "Async test");

            let result = service
                .handle_message(&runtime, &mut message, None)
                .await
                .expect("Failed to handle message");

            assert!(result.did_respond);
            assert!(result.response_content.is_some());
            assert_eq!(
                result.response_content.as_ref().unwrap().text,
                Some("Hello from async!".to_string())
            );
        }

        #[tokio::test]
        async fn test_compose_state_async() {
            let runtime = UnifiedRuntime::<MockAdapter>::new(UnifiedRuntimeOptions::default())
                .expect("Failed to create runtime");

            let message = Memory::message(UUID::new_v4(), UUID::new_v4(), "Async hello");
            let state = runtime
                .compose_state(&message)
                .await
                .expect("Failed to compose state");

            assert!(state.text.contains("Async hello"));
        }

        #[tokio::test]
        async fn test_database_adapter_async() {
            let adapter = MockAdapter::new();

            assert!(!adapter.is_ready().await.expect("is_ready failed"));
            adapter.init().await.expect("init failed");
            assert!(adapter.is_ready().await.expect("is_ready failed"));
            adapter.close().await.expect("close failed");
            assert!(!adapter.is_ready().await.expect("is_ready failed"));
        }
    }

    // ========== SHARED TESTS (run in both modes) ==========

    #[test]
    fn test_uuid_generation() {
        let uuid1 = UUID::new_v4();
        let uuid2 = UUID::new_v4();
        assert_ne!(uuid1, uuid2);
    }

    #[test]
    fn test_string_to_uuid_deterministic() {
        let uuid1 = string_to_uuid("test");
        let uuid2 = string_to_uuid("test");
        assert_eq!(uuid1, uuid2);

        let uuid3 = string_to_uuid("different");
        assert_ne!(uuid1, uuid3);
    }

    #[test]
    fn test_setting_value_conversion() {
        let json_str = serde_json::Value::String("hello".to_string());
        let setting = json_to_setting(&json_str);
        assert_eq!(setting, Some(SettingValue::String("hello".to_string())));

        let json_bool = serde_json::Value::Bool(true);
        let setting = json_to_setting(&json_bool);
        assert_eq!(setting, Some(SettingValue::Bool(true)));

        let json_num = serde_json::json!(42.5);
        let setting = json_to_setting(&json_num);
        assert_eq!(setting, Some(SettingValue::Number(42.5)));
    }

    #[test]
    fn test_message_processing_result_default() {
        let result = UnifiedMessageProcessingResult::default();
        assert!(!result.did_respond);
        assert!(result.response_content.is_none());
        assert!(result.response_messages.is_empty());
    }

    #[test]
    fn test_now_millis() {
        let t1 = now_millis();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let t2 = now_millis();
        assert!(t2 > t1);
    }
}
