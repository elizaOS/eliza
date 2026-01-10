//! AgentRuntime implementation for elizaOS
//!
//! This module provides the core runtime for elizaOS agents.

use crate::types::{
    ActionHandler, ActionResult, Agent, Character, Entity, EvaluatorHandler, EventPayload,
    EventType, GetMemoriesParams, HandlerOptions, Memory, Plugin, ProviderHandler, Room,
    RuntimeSettings, SearchMemoriesParams, SettingValue, State, Task, World, UUID,
};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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

/// Log level for the runtime
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LogLevel {
    /// Trace level (most verbose)
    Trace,
    /// Debug level
    Debug,
    /// Info level
    Info,
    /// Warning level
    Warn,
    /// Error level (default)
    #[default]
    Error,
    /// Fatal level (least verbose)
    Fatal,
}

impl LogLevel {
    /// Convert to tracing level filter
    pub fn to_tracing_level(self) -> tracing::Level {
        match self {
            LogLevel::Trace => tracing::Level::TRACE,
            LogLevel::Debug => tracing::Level::DEBUG,
            LogLevel::Info => tracing::Level::INFO,
            LogLevel::Warn => tracing::Level::WARN,
            LogLevel::Error | LogLevel::Fatal => tracing::Level::ERROR,
        }
    }
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
    /// Log level for the runtime. Defaults to Error.
    pub log_level: LogLevel,
}

/// Event handler function type
pub type EventHandler = Arc<dyn Fn(EventPayload) -> Result<()> + Send + Sync>;

/// Model handler function type
pub type ModelHandler =
    Arc<dyn Fn(&str, serde_json::Value) -> Result<serde_json::Value> + Send + Sync>;

fn json_value_to_setting_value(value: &serde_json::Value) -> Option<SettingValue> {
    match value {
        serde_json::Value::String(s) => Some(SettingValue::String(s.clone())),
        serde_json::Value::Bool(b) => Some(SettingValue::Bool(*b)),
        serde_json::Value::Number(n) => n.as_f64().map(SettingValue::Number),
        serde_json::Value::Null => Some(SettingValue::Null),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => None,
    }
}

fn setting_value_to_json_value(value: &SettingValue) -> serde_json::Value {
    match value {
        SettingValue::String(s) => serde_json::Value::String(s.clone()),
        SettingValue::Bool(b) => serde_json::Value::Bool(*b),
        SettingValue::Number(n) => serde_json::Number::from_f64(*n)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        SettingValue::Null => serde_json::Value::Null,
    }
}

fn normalize_setting_value(value: SettingValue) -> SettingValue {
    match value {
        SettingValue::String(s) => {
            let decrypted = crate::settings::decrypt_string_value(&s, &crate::settings::get_salt());
            if decrypted == "true" {
                SettingValue::Bool(true)
            } else if decrypted == "false" {
                SettingValue::Bool(false)
            } else {
                SettingValue::String(decrypted)
            }
        }
        other => other,
    }
}

/// Model handler function type for runtime
/// 
/// This type represents an async function that takes model parameters (as JSON)
/// and returns a string result. It is used to register model handlers that can
/// be called via `runtime.use_model()`.
/// 
/// For native builds, handlers must be Send + Sync for multi-threaded async.
/// For WASM builds, this constraint is relaxed since WASM is single-threaded.
#[cfg(not(feature = "wasm"))]
pub type RuntimeModelHandler = Box<
    dyn Fn(serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>
        + Send
        + Sync,
>;

/// Model handler function type for runtime (WASM version)
/// 
/// This type represents an async function that takes model parameters (as JSON)
/// and returns a string result. The WASM version does not require Send + Sync
/// since WebAssembly is single-threaded.
#[cfg(feature = "wasm")]
pub type RuntimeModelHandler = Box<
    dyn Fn(serde_json::Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>>>>
>;

/// The core runtime for an elizaOS agent
///
/// Users can create an AgentRuntime directly without needing a higher-level abstraction:
///
/// ```rust,ignore
/// use elizaos::{AgentRuntime, Character, DEFAULT_UUID_STR};
/// use elizaos::runtime::{RuntimeOptions, LogLevel};
///
/// let runtime = AgentRuntime::new(RuntimeOptions {
///     character: Some(Character { name: "MyAgent".to_string(), ..Default::default() }),
///     log_level: LogLevel::Info, // defaults to Error
///     ..Default::default()
/// }).await?;
/// await runtime.initialize()?;
///
/// // For memory operations, use UUID::default_uuid() if no specific room/world needed
/// ```
pub struct AgentRuntime {
    /// Agent ID
    pub agent_id: UUID,
    /// Character configuration
    pub character: RwLock<Character>,
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
    /// Plugins provided at construction time (registered during `initialize()`)
    initial_plugins: Mutex<Vec<Plugin>>,
    /// Event handlers
    events: RwLock<HashMap<String, Vec<EventHandler>>>,
    /// Services
    services: RwLock<HashMap<String, Arc<dyn Service>>>,
    /// Model handlers (maps model type like "TEXT_LARGE" to handler)
    model_handlers: RwLock<HashMap<String, RuntimeModelHandler>>,
    /// Runtime settings
    settings: RwLock<RuntimeSettings>,
    /// Current run ID (tracked for prompt/model call correlation)
    current_run_id: Mutex<Option<UUID>>,
    /// Current room ID (for associating logs with a conversation)
    current_room_id: Mutex<Option<UUID>>,
    /// Initialization promise/future resolved
    initialized: RwLock<bool>,
    /// Log level for this runtime
    log_level: LogLevel,
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
        let agent_id = character
            .id
            .clone()
            .or(opts.agent_id)
            .unwrap_or_else(|| crate::types::string_to_uuid(&character.name));

        let log_level = opts.log_level;
        info!("Creating AgentRuntime for agent: {} with log level {:?}", agent_id, log_level);

        let runtime = AgentRuntime {
            agent_id,
            character: RwLock::new(character),
            adapter: opts.adapter,
            actions: RwLock::new(Vec::new()),
            providers: RwLock::new(Vec::new()),
            evaluators: RwLock::new(Vec::new()),
            plugins: RwLock::new(Vec::new()),
            initial_plugins: Mutex::new(opts.plugins),
            events: RwLock::new(HashMap::new()),
            services: RwLock::new(HashMap::new()),
            model_handlers: RwLock::new(HashMap::new()),
            settings: RwLock::new(opts.settings.unwrap_or_default()),
            current_run_id: Mutex::new(None),
            current_room_id: Mutex::new(None),
            initialized: RwLock::new(false),
            log_level,
        };

        Ok(runtime)
    }

    /// Get the configured log level for this runtime
    pub fn log_level(&self) -> LogLevel {
        self.log_level
    }

    /// Initialize the runtime
    pub async fn initialize(&self) -> Result<()> {
        info!("Initializing AgentRuntime for agent: {}", self.agent_id);

        // Register plugins provided during construction (mirrors TS/Py behavior).
        // This happens before database init so plugins can register adapters/services/models/events.
        let plugins_to_register: Vec<Plugin> = {
            let mut guard = self.initial_plugins.lock().expect("lock poisoned");
            std::mem::take(&mut *guard)
        };
        for plugin in plugins_to_register {
            self.register_plugin(plugin).await?;
        }

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
    pub async fn register_plugin(&self, mut plugin: Plugin) -> Result<()> {
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

        // Register model handlers (move them out of the plugin)
        let model_handlers = std::mem::take(&mut plugin.model_handlers);
        for (model_type, handler) in model_handlers {
            debug!("Registering model handler for: {}", model_type);
            #[cfg(not(feature = "wasm"))]
            {
                let mut handlers = self.model_handlers.write().await;
                handlers.insert(model_type, handler);
            }
            #[cfg(feature = "wasm")]
            {
                let mut handlers = self.model_handlers.write().unwrap();
                handlers.insert(model_type, handler);
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

    /// Get a setting value (TypeScript-compatible semantics).
    ///
    /// Precedence matches the TS runtime:
    /// 1) `character.secrets[key]`
    /// 2) `character.settings[key]`
    /// 3) `character.settings.secrets[key]` (nested secrets)
    /// 4) runtime settings (`RuntimeSettings`)
    ///
    /// Non-primitive values (objects/arrays) are treated as missing (TS returns null).
    pub async fn get_setting(&self, key: &str) -> Option<SettingValue> {
        // NOTE: This method intentionally returns only primitive values.
        // Complex JSON values are ignored for parity with TS getSetting().

        // Read character once for consistent lookups.
        let character = {
            #[cfg(not(feature = "wasm"))]
            {
                self.character.read().await.clone()
            }
            #[cfg(feature = "wasm")]
            {
                self.character.read().unwrap().clone()
            }
        };

        // 1) character.secrets
        if let Some(secrets) = &character.secrets {
            if let Some(v) = secrets.values.get(key) {
                if let Some(setting) = json_value_to_setting_value(v) {
                    return Some(normalize_setting_value(setting));
                }
            }
        }

        // 2) character.settings direct
        if let Some(settings) = &character.settings {
            if let Some(v) = settings.values.get(key) {
                if let Some(setting) = json_value_to_setting_value(v) {
                    return Some(normalize_setting_value(setting));
                }
            }

            // 3) character.settings.secrets nested
            if let Some(nested) = settings.values.get("secrets") {
                if let Some(nested_map) = nested.as_object() {
                    if let Some(v) = nested_map.get(key) {
                        if let Some(setting) = json_value_to_setting_value(v) {
                            return Some(normalize_setting_value(setting));
                        }
                    }
                }
            }
        }

        // 4) runtime settings map
        #[cfg(not(feature = "wasm"))]
        {
            let settings = self.settings.read().await;
            settings
                .values
                .get(key)
                .cloned()
                .map(normalize_setting_value)
        }
        #[cfg(feature = "wasm")]
        {
            let settings = self.settings.read().unwrap();
            settings
                .values
                .get(key)
                .cloned()
                .map(normalize_setting_value)
        }
    }

    /// Set a setting value (TypeScript-compatible semantics).
    ///
    /// - `secret = true` writes to `character.secrets`
    /// - `secret = false` writes to `character.settings`
    pub async fn set_setting(&self, key: &str, value: SettingValue, secret: bool) {
        if secret {
            #[cfg(not(feature = "wasm"))]
            {
                let mut character = self.character.write().await;
                if character.secrets.is_none() {
                    character.secrets = Some(crate::types::CharacterSecrets::default());
                }
                if let Some(secrets) = &mut character.secrets {
                    secrets
                        .values
                        .insert(key.to_string(), setting_value_to_json_value(&value));
                }
            }
            #[cfg(feature = "wasm")]
            {
                let mut character = self.character.write().unwrap();
                if character.secrets.is_none() {
                    character.secrets = Some(crate::types::CharacterSecrets::default());
                }
                if let Some(secrets) = &mut character.secrets {
                    secrets
                        .values
                        .insert(key.to_string(), setting_value_to_json_value(&value));
                }
            }
            return;
        }

        #[cfg(not(feature = "wasm"))]
        {
            let mut character = self.character.write().await;
            if character.settings.is_none() {
                character.settings = Some(crate::types::CharacterSettings::default());
            }
            if let Some(settings) = &mut character.settings {
                settings
                    .values
                    .insert(key.to_string(), setting_value_to_json_value(&value));
            }
        }
        #[cfg(feature = "wasm")]
        {
            let mut character = self.character.write().unwrap();
            if character.settings.is_none() {
                character.settings = Some(crate::types::CharacterSettings::default());
            }
            if let Some(settings) = &mut character.settings {
                settings
                    .values
                    .insert(key.to_string(), setting_value_to_json_value(&value));
            }
        }
    }

    /// Compose state for a message
    pub async fn compose_state(&self, message: &Memory) -> Result<State> {
        let mut state = State::new();

        // Get providers - clone to avoid holding lock across await
        #[cfg(not(feature = "wasm"))]
        let providers: Vec<_> = self.providers.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let providers: Vec<_> = self.providers.read().unwrap().iter().cloned().collect();

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

        // Clone to avoid holding lock across await
        #[cfg(not(feature = "wasm"))]
        let actions: Vec<_> = self.actions.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let actions: Vec<_> = self.actions.read().unwrap().iter().cloned().collect();

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
        {
            let mut current = self.current_run_id.lock().expect("lock poisoned");
            *current = Some(run_id.clone());
        }
        {
            let mut current_room = self.current_room_id.lock().expect("lock poisoned");
            *current_room = room_id.cloned();
        }

        debug!("Started run: {} for room: {:?}", run_id, room_id);
        run_id
    }

    /// End the current run
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

    /// Get the current run ID
    pub fn get_current_run_id(&self) -> UUID {
        let mut current = self.current_run_id.lock().expect("lock poisoned");
        match &*current {
            Some(id) => id.clone(),
            None => {
                let id = UUID::new_v4();
                *current = Some(id.clone());
                id
            }
        }
    }

    /// Get the current room ID (if any) associated with the current run.
    pub fn get_current_room_id(&self) -> Option<UUID> {
        let current = self.current_room_id.lock().expect("lock poisoned");
        current.clone()
    }

    /// Get a reference to the database adapter (if any)
    pub fn get_adapter(&self) -> Option<&Arc<dyn DatabaseAdapter>> {
        self.adapter.as_ref()
    }

    /// Get a message service for handling incoming messages
    /// 
    /// This returns a new DefaultMessageService instance. Usage:
    /// ```rust,ignore
    /// let result = runtime.message_service().handle_message(&runtime, &mut message, None, None).await?;
    /// ```
    pub fn message_service(&self) -> crate::services::DefaultMessageService {
        crate::services::DefaultMessageService::new()
    }

    /// Register a model handler for a specific model type
    /// 
    /// Model types are strings like "TEXT_LARGE", "TEXT_SMALL", "TEXT_EMBEDDING"
    pub async fn register_model(&self, model_type: &str, handler: RuntimeModelHandler) {
        #[cfg(not(feature = "wasm"))]
        {
            let mut handlers = self.model_handlers.write().await;
            handlers.insert(model_type.to_string(), handler);
        }
        #[cfg(feature = "wasm")]
        {
            let mut handlers = self.model_handlers.write().unwrap();
            handlers.insert(model_type.to_string(), handler);
        }
        debug!("Registered model handler for: {}", model_type);
    }

    /// Use a model to generate text
    /// 
    /// This looks up the registered handler for the given model type and calls it.
    /// 
    /// # Example
    /// ```rust,ignore
    /// let result = runtime.use_model("TEXT_LARGE", serde_json::json!({
    ///     "prompt": "Hello!",
    ///     "system": "You are helpful.",
    ///     "temperature": 0.7
    /// })).await?;
    /// ```
    pub async fn use_model(&self, model_type: &str, params: serde_json::Value) -> Result<String> {
        let handler = {
            #[cfg(not(feature = "wasm"))]
            {
                let handlers = self.model_handlers.read().await;
                handlers.get(model_type).map(|h| {
                    // We need to call the handler - create a boxed future
                    h(params.clone())
                })
            }
            #[cfg(feature = "wasm")]
            {
                let handlers = self.model_handlers.read().unwrap();
                handlers.get(model_type).map(|h| h(params.clone()))
            }
        };

        match handler {
            Some(future) => future.await,
            None => Err(anyhow::anyhow!(
                "No model handler registered for type: {}. Register a model handler using register_model() or pass a plugin with model handlers.",
                model_type
            )),
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
            for (name, _service) in services.iter() {
                // Note: In WASM, we'd need to handle this differently
                // Services would be stopped synchronously if needed
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

        let character = runtime.character.read().await.clone();
        assert_eq!(character.name, "TestAgent");
    }

    #[tokio::test]
    async fn test_runtime_settings() {
        let runtime = AgentRuntime::new(RuntimeOptions::default()).await.unwrap();

        runtime
            .set_setting(
                "test_key",
                SettingValue::String("test_value".to_string()),
                false,
            )
            .await;
        let value = runtime.get_setting("test_key").await;
        assert_eq!(value, Some(SettingValue::String("test_value".to_string())));
    }

    #[tokio::test]
    async fn test_runtime_settings_string_bool_normalization() {
        let runtime = AgentRuntime::new(RuntimeOptions::default()).await.unwrap();

        runtime
            .set_setting("FLAG_TRUE", SettingValue::String("true".to_string()), false)
            .await;
        runtime
            .set_setting("FLAG_FALSE", SettingValue::String("false".to_string()), false)
            .await;

        assert_eq!(runtime.get_setting("FLAG_TRUE").await, Some(SettingValue::Bool(true)));
        assert_eq!(
            runtime.get_setting("FLAG_FALSE").await,
            Some(SettingValue::Bool(false))
        );
    }

    #[tokio::test]
    async fn test_runtime_settings_decrypts_encrypted_values() {
        let runtime = AgentRuntime::new(RuntimeOptions::default()).await.unwrap();
        let salt = crate::settings::get_salt();

        let plaintext = "super-secret";
        let encrypted = crate::settings::encrypt_string_value(plaintext, &salt);

        runtime
            .set_setting("ENCRYPTED", SettingValue::String(encrypted), false)
            .await;

        assert_eq!(
            runtime.get_setting("ENCRYPTED").await,
            Some(SettingValue::String(plaintext.to_string()))
        );
    }

    #[tokio::test]
    async fn test_run_management() {
        let runtime = AgentRuntime::new(RuntimeOptions::default()).await.unwrap();

        let run_id = runtime.start_run(None);
        assert!(!run_id.as_str().is_empty());

        runtime.end_run();
    }
}
