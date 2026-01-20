//! AgentRuntime implementation for elizaOS
//!
//! This module provides the core runtime for elizaOS agents.

use crate::types::agent::{Agent, Bio, Character, CharacterSecrets, CharacterSettings};
use crate::types::components::{
    ActionDefinition, ActionHandler, ActionParameters, ActionResult, EvaluatorDefinition,
    EvaluatorHandler, HandlerOptions, ProviderDefinition, ProviderHandler,
};
use crate::types::database::{GetMemoriesParams, SearchMemoriesParams};
use crate::types::environment::{Entity, Room, World};
use crate::types::events::{EventPayload, EventType};
use crate::types::memory::Memory;
use crate::types::model::LLMMode;
use crate::types::plugin::Plugin;
use crate::types::primitives::{string_to_uuid, UUID};
use crate::types::settings::{RuntimeSettings, SettingValue};
use crate::types::state::State;
use crate::types::task::Task;
use crate::advanced_planning;
use crate::advanced_memory;
use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info, warn};
use std::any::Any;

// RwLock type - different for native (async) vs wasm (sync)
#[cfg(not(feature = "wasm"))]
use tokio::sync::RwLock;

#[cfg(feature = "wasm")]
use std::sync::RwLock;

// Bootstrap uses an agent-runtime interface trait that is historically imported
// via `crate::runtime::IAgentRuntime`. Re-export it when the bootstrap module is present.
#[cfg(all(feature = "bootstrap-internal", not(feature = "wasm")))]
pub use crate::bootstrap::runtime::{IAgentRuntime, ModelOutput, ModelParams};

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
    /// Disable basic bootstrap capabilities (reply, ignore, none).
    ///
    /// - `Some(true)`: disable basic capabilities regardless of character settings
    /// - `Some(false)`: enable basic capabilities regardless of character settings
    /// - `None` (default): defer to `DISABLE_BASIC_CAPABILITIES` character setting
    pub disable_basic_capabilities: Option<bool>,
    /// Enable extended bootstrap capabilities (facts, roles, settings, etc.).
    ///
    /// - `Some(true)`: enable extended capabilities regardless of character settings
    /// - `Some(false)`: disable extended capabilities regardless of character settings
    /// - `None` (default): defer to `ENABLE_EXTENDED_CAPABILITIES` character setting
    pub enable_extended_capabilities: Option<bool>,
    /// Enable action planning mode for multi-action execution.
    /// When Some(true) (default), agent can plan and execute multiple actions per response.
    /// When Some(false), agent executes only a single action per response (performance
    /// optimization useful for game situations where state updates with every action).
    /// When None, the ACTION_PLANNING setting will be checked.
    pub action_planning: Option<bool>,
    /// LLM mode for overriding model selection.
    /// When Some(LLMMode::Small), all text generation model calls use TEXT_SMALL.
    /// When Some(LLMMode::Large), all text generation model calls use TEXT_LARGE.
    /// When Some(LLMMode::Default) or None, uses the model type specified in the call.
    pub llm_mode: Option<LLMMode>,
    /// Enable or disable the shouldRespond evaluation.
    /// When Some(true) (default), the agent evaluates whether to respond to each message.
    /// When Some(false), the agent always responds (ChatGPT mode).
    /// When None, the CHECK_SHOULD_RESPOND setting will be checked.
    pub check_should_respond: Option<bool>,
    /// Enable autonomy capabilities for autonomous agent operation.
    /// When true, the agent can operate autonomously with its own thinking loop.
    ///
    /// - `Some(true)`: enable autonomy regardless of character settings
    /// - `Some(false)`: disable autonomy regardless of character settings
    /// - `None` (default): defer to `ENABLE_AUTONOMY` character setting
    pub enable_autonomy: Option<bool>,
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

/// Model handler for native builds (Send + Sync)
#[cfg(not(feature = "wasm"))]
pub type RuntimeModelHandler = Box<
    dyn Fn(
            serde_json::Value,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>
        + Send
        + Sync,
>;

/// Model handler for WASM builds (no Send + Sync required)
#[cfg(feature = "wasm")]
pub type RuntimeModelHandler = Box<
    dyn Fn(
        serde_json::Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>>>>,
>;

/// Static counter for anonymous agent naming
static ANONYMOUS_AGENT_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Provider access log entry for trajectory tracing.
#[derive(Clone, Debug, Default)]
pub struct TrajectoryProviderAccess {
    /// Trajectory step identifier.
    pub step_id: String,
    /// Provider name executed.
    pub provider_name: String,
    /// Purpose string (e.g. "compose_state").
    pub purpose: String,
    /// Provider result data (best-effort).
    pub data: HashMap<String, Value>,
    /// Optional query metadata (best-effort).
    pub query: Option<HashMap<String, Value>>,
    /// Timestamp in milliseconds.
    pub timestamp_ms: i64,
}

/// LLM call log entry for trajectory tracing.
#[derive(Clone, Debug, Default)]
pub struct TrajectoryLlmCall {
    /// Trajectory step identifier.
    pub step_id: String,
    /// Model type/name.
    pub model: String,
    /// System prompt used.
    pub system_prompt: String,
    /// User prompt used.
    pub user_prompt: String,
    /// Model response (possibly truncated).
    pub response: String,
    /// Temperature used.
    pub temperature: f64,
    /// Max tokens used.
    pub max_tokens: i64,
    /// Purpose string (e.g. "action").
    pub purpose: String,
    /// Action type string (e.g. "runtime.use_model").
    pub action_type: String,
    /// Latency in milliseconds.
    pub latency_ms: i64,
    /// Timestamp in milliseconds.
    pub timestamp_ms: i64,
}

/// Trajectory logs collected during a run.
#[derive(Clone, Debug, Default)]
pub struct TrajectoryLogs {
    /// Provider access events captured during the trajectory step.
    pub provider_access: Vec<TrajectoryProviderAccess>,
    /// LLM call events captured during the trajectory step.
    pub llm_calls: Vec<TrajectoryLlmCall>,
}

/// The core runtime for an elizaOS agent
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
    /// Current trajectory step ID (benchmarks / training traces)
    current_trajectory_step_id: Mutex<Option<String>>,
    /// In-memory trajectory logs (benchmarks / training traces)
    trajectory_logs: Mutex<TrajectoryLogs>,
    /// Initialization promise/future resolved
    initialized: RwLock<bool>,
    /// Log level for this runtime
    log_level: LogLevel,
    /// Flag to track if the character was auto-generated (no character provided)
    is_anonymous_character: bool,
    /// Action planning option (None means check settings at runtime)
    action_planning_option: Option<bool>,
    /// LLM mode option (None means check settings at runtime)
    llm_mode_option: Option<LLMMode>,
    /// Check should respond option (None means check settings at runtime)
    check_should_respond_option: Option<bool>,
    /// Capability options captured at construction time (tri-state; `None` means defer to settings).
    capability_options: CapabilityOptions,
    /// Runtime flag that toggles autonomy execution.
    enable_autonomy: AtomicBool,
}

/// Tri-state capability options (mirrors TypeScript bootstrap capability config behavior).
#[derive(Clone, Debug, Default)]
struct CapabilityOptions {
    disable_basic: Option<bool>,
    enable_extended: Option<bool>,
    enable_autonomy: Option<bool>,
    skip_character_provider: bool,
}

/// Service trait for long-running services
#[async_trait::async_trait]
pub trait Service: Send + Sync {
    /// Get the service type
    fn service_type(&self) -> &str;

    /// Support downcasting to concrete service types.
    fn as_any(&self) -> &dyn Any;

    /// Stop the service
    async fn stop(&self) -> Result<()>;
}

impl AgentRuntime {
    /// Create a new AgentRuntime
    pub async fn new(opts: RuntimeOptions) -> Result<Arc<Self>> {
        // Create default anonymous character if none provided
        let (character, is_anonymous) = match opts.character {
            Some(c) => (c, false),
            None => {
                use std::sync::atomic::Ordering;
                let counter = ANONYMOUS_AGENT_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
                let character = Character {
                    name: format!("Agent-{}", counter),
                    bio: Bio::Single("An anonymous agent".to_string()),
                    ..Default::default()
                };
                (character, true)
            }
        };

        let agent_id = character
            .id
            .clone()
            .or(opts.agent_id)
            .unwrap_or_else(|| string_to_uuid(&character.name));

        let log_level = opts.log_level;
        info!(
            "Creating AgentRuntime for agent: {} with log level {:?}",
            agent_id, log_level
        );

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
            current_trajectory_step_id: Mutex::new(None),
            trajectory_logs: Mutex::new(TrajectoryLogs::default()),
            initialized: RwLock::new(false),
            log_level,
            is_anonymous_character: is_anonymous,
            action_planning_option: opts.action_planning,
            llm_mode_option: opts.llm_mode,
            check_should_respond_option: opts.check_should_respond,
            capability_options: CapabilityOptions {
                disable_basic: opts.disable_basic_capabilities,
                enable_extended: opts.enable_extended_capabilities,
                enable_autonomy: opts.enable_autonomy,
                skip_character_provider: is_anonymous,
            },
            enable_autonomy: AtomicBool::new(opts.enable_autonomy.unwrap_or(false)),
        };

        Ok(Arc::new(runtime))
    }

    /// Check if the character is anonymous (auto-generated)
    pub fn is_anonymous_character(&self) -> bool {
        self.is_anonymous_character
    }

    /// Get the configured log level for this runtime
    pub fn log_level(&self) -> LogLevel {
        self.log_level
    }

    /// Check if action planning mode is enabled
    pub async fn is_action_planning_enabled(&self) -> bool {
        // Constructor option takes precedence
        if let Some(enabled) = self.action_planning_option {
            return enabled;
        }

        // Check character settings
        if let Some(setting) = self.get_setting("ACTION_PLANNING").await {
            match setting {
                SettingValue::Bool(b) => return b,
                SettingValue::String(s) => return s.to_lowercase() == "true",
                _ => {}
            }
        }

        // Default to true (action planning enabled)
        true
    }

    /// Get the LLM mode for model selection override
    pub async fn get_llm_mode(&self) -> LLMMode {
        // Constructor option takes precedence
        if let Some(mode) = self.llm_mode_option {
            return mode;
        }

        // Check character settings
        if let Some(SettingValue::String(s)) = self.get_setting("LLM_MODE").await {
            return LLMMode::parse(&s);
        }

        // Default to Default (no override)
        LLMMode::Default
    }

    /// Check if the shouldRespond evaluation is enabled.
    ///
    /// When enabled (default: true), the agent evaluates whether to respond to each message.
    /// When disabled, the agent always responds (ChatGPT mode) - useful for direct chat interfaces.
    ///
    /// Priority: constructor option > character setting CHECK_SHOULD_RESPOND > default (true)
    pub async fn is_check_should_respond_enabled(&self) -> bool {
        // Constructor option takes precedence
        if let Some(enabled) = self.check_should_respond_option {
            return enabled;
        }

        // Check character settings
        if let Some(setting) = self.get_setting("CHECK_SHOULD_RESPOND").await {
            match setting {
                SettingValue::Bool(b) => return b,
                SettingValue::String(s) => return s.to_lowercase() != "false",
                _ => {}
            }
        }

        // Default to true (check should respond is enabled)
        true
    }

    /// Initialize the runtime.
    ///
    /// Note: this method requires an `Arc<Self>` receiver so the runtime can safely
    /// hand `Weak<AgentRuntime>` handles to internal/built-in plugins and services.
    pub async fn initialize(self: &Arc<Self>) -> Result<()> {
        info!("Initializing AgentRuntime for agent: {}", self.agent_id);

        // Resolve capability configuration (constructor options > character settings > defaults).
        let disable_basic = self.capability_options.disable_basic.unwrap_or(
            parse_truthy_setting(self.get_setting("DISABLE_BASIC_CAPABILITIES").await),
        );
        let enable_extended = self.capability_options.enable_extended.unwrap_or(
            parse_truthy_setting(self.get_setting("ENABLE_EXTENDED_CAPABILITIES").await),
        );
        let enable_autonomy = self.capability_options.enable_autonomy.unwrap_or(
            parse_truthy_setting(self.get_setting("ENABLE_AUTONOMY").await),
        );
        self.set_enable_autonomy(enable_autonomy);

        // Bootstrap plugin parity: always register built-in bootstrap capabilities first.
        // Capability config precedence matches TS: constructor options > character settings > defaults.
        let bootstrap_plugin = crate::bootstrap_core::create_bootstrap_plugin(
            Arc::downgrade(self),
            crate::bootstrap_core::CapabilityConfig {
                disable_basic,
                enable_extended,
                enable_autonomy,
                skip_character_provider: self.capability_options.skip_character_provider,
            },
        );
        self.register_plugin(bootstrap_plugin).await?;

        // Advanced planning is built into core, but only loaded when enabled on the character.
        let advanced_planning_enabled = {
            #[cfg(not(feature = "wasm"))]
            {
                let character = self.character.read().await;
                character.advanced_planning.unwrap_or(false)
            }
            #[cfg(feature = "wasm")]
            {
                let character = self.character.read().unwrap();
                character.advanced_planning.unwrap_or(false)
            }
        };
        if advanced_planning_enabled {
            self.register_service(
                "planning",
                Arc::new(advanced_planning::PlanningService::default()),
            )
            .await;

            // Register advanced planning actions/providers (parity with TS createAdvancedPlanningPlugin()).
            let plugin = advanced_planning::create_advanced_planning_plugin(Arc::downgrade(self));
            self.register_plugin(plugin).await?;
        }

        // Advanced memory is built into core, but only loaded when enabled on the character.
        let advanced_memory_enabled = {
            #[cfg(not(feature = "wasm"))]
            {
                let character = self.character.read().await;
                character.advanced_memory.unwrap_or(false)
            }
            #[cfg(feature = "wasm")]
            {
                let character = self.character.read().unwrap();
                character.advanced_memory.unwrap_or(false)
            }
        };
        if advanced_memory_enabled {
            let svc = Arc::new(advanced_memory::MemoryService::default());
            svc.configure_from_runtime(self).await;
            self.register_service("memory", svc).await;
            let plugin = advanced_memory::create_advanced_memory_plugin(Arc::downgrade(self));
            self.register_plugin(plugin).await?;
        }

        // Autonomy is built into core, but only loaded when enabled via capability config.
        if enable_autonomy {
            #[cfg(not(feature = "wasm"))]
            {
                let service = crate::autonomy::AutonomyService::start(Arc::downgrade(self)).await?;
                self.register_service(crate::autonomy::AUTONOMY_SERVICE_TYPE, service.clone())
                    .await;
                let plugin = crate::autonomy::create_autonomy_plugin(Arc::downgrade(self), service);
                self.register_plugin(plugin).await?;
            }
        }

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

    /// Register a long-running service with the runtime.
    ///
    /// Registered services are stopped automatically when `runtime.stop()` is called.
    pub async fn register_service(&self, name: &str, service: Arc<dyn Service>) {
        #[cfg(not(feature = "wasm"))]
        {
            let mut services = self.services.write().await;
            services.insert(name.to_string(), service);
        }
        #[cfg(feature = "wasm")]
        {
            let mut services = self.services.write().unwrap();
            services.insert(name.to_string(), service);
        }
    }

    /// Get a previously registered service by name.
    pub async fn get_service(&self, name: &str) -> Option<Arc<dyn Service>> {
        #[cfg(not(feature = "wasm"))]
        {
            let services = self.services.read().await;
            services.get(name).cloned()
        }
        #[cfg(feature = "wasm")]
        {
            let services = self.services.read().unwrap();
            services.get(name).cloned()
        }
    }

    /// Get a setting value
    pub async fn get_setting(&self, key: &str) -> Option<SettingValue> {
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

    /// Get the runtime autonomy flag.
    pub fn enable_autonomy(&self) -> bool {
        self.enable_autonomy.load(Ordering::SeqCst)
    }

    /// Update the runtime autonomy flag.
    pub fn set_enable_autonomy(&self, enabled: bool) {
        self.enable_autonomy.store(enabled, Ordering::SeqCst);
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
                    character.secrets = Some(CharacterSecrets::default());
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
                    character.secrets = Some(CharacterSecrets::default());
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
                character.settings = Some(CharacterSettings::default());
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
                character.settings = Some(CharacterSettings::default());
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
        let traj_step_id = self.get_trajectory_step_id();
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
                        state.merge_values_struct(&values);
                    }

                    // Trajectory logging (best-effort; must never break core flow)
                    if let Some(step_id) = &traj_step_id {
                        let mut logs = self.trajectory_logs.lock().expect("lock poisoned");
                        logs.provider_access.push(TrajectoryProviderAccess {
                            step_id: step_id.clone(),
                            provider_name: def.name.clone(),
                            purpose: "compose_state".to_string(),
                            data: HashMap::new(),
                            query: message
                                .content
                                .text
                                .as_ref()
                                .map(|t| {
                                    [(
                                        "message".to_string(),
                                        Value::String(t.chars().take(2000).collect()),
                                    )]
                                    .into_iter()
                                    .collect()
                                }),
                            timestamp_ms: chrono_timestamp(),
                        });
                    }
                }
                Err(e) => {
                    warn!("Provider {} failed: {}", def.name, e);
                }
            }
        }

        Ok(state)
    }

    /// List registered action definitions (best-effort).
    pub async fn list_action_definitions(&self) -> Vec<ActionDefinition> {
        #[cfg(not(feature = "wasm"))]
        let actions: Vec<_> = self.actions.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let actions: Vec<_> = self.actions.read().unwrap().iter().cloned().collect();

        actions.into_iter().map(|a| a.definition()).collect()
    }

    /// List registered provider definitions (best-effort).
    pub async fn list_provider_definitions(&self) -> Vec<ProviderDefinition> {
        #[cfg(not(feature = "wasm"))]
        let providers: Vec<_> = self.providers.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let providers: Vec<_> = self.providers.read().unwrap().iter().cloned().collect();

        providers.into_iter().map(|p| p.definition()).collect()
    }

    /// List registered evaluator definitions (best-effort).
    pub async fn list_evaluator_definitions(&self) -> Vec<EvaluatorDefinition> {
        #[cfg(not(feature = "wasm"))]
        let evaluators: Vec<_> = self.evaluators.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let evaluators: Vec<_> = self.evaluators.read().unwrap().iter().cloned().collect();

        evaluators.into_iter().map(|e| e.definition()).collect()
    }

    /// Process actions for a message
    pub async fn process_actions(
        &self,
        message: &Memory,
        state: &State,
        options: Option<&HandlerOptions>,
    ) -> Result<Vec<ActionResult>> {
        let mut results = Vec::new();

        // Check if action planning is enabled
        let action_planning_enabled = self.is_action_planning_enabled().await;

        // Clone to avoid holding lock across await
        #[cfg(not(feature = "wasm"))]
        let all_actions: Vec<_> = self.actions.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let all_actions: Vec<_> = self.actions.read().unwrap().iter().cloned().collect();

        // Limit to single action if action planning is disabled
        let actions: Vec<_> = if action_planning_enabled {
            all_actions
        } else if !all_actions.is_empty() {
            debug!("Action planning disabled, limiting to first action");
            vec![all_actions.into_iter().next().unwrap()]
        } else {
            all_actions
        };

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

    /// Process a specific ordered list of selected actions (TypeScript/Python parity).
    ///
    /// This executes only the actions selected by the model, in order, optionally attaching
    /// per-action parameters parsed from a `<params>` block.
    pub async fn process_selected_actions(
        &self,
        message: &Memory,
        state: &State,
        selected_actions: &[String],
        action_params: &HashMap<String, HashMap<String, Value>>,
    ) -> Result<Vec<ActionResult>> {
        let action_planning_enabled = self.is_action_planning_enabled().await;
        let to_run: Vec<String> = if action_planning_enabled {
            selected_actions.to_vec()
        } else {
            selected_actions.get(0).cloned().into_iter().collect()
        };

        // Clone to avoid holding lock across await
        #[cfg(not(feature = "wasm"))]
        let handlers: Vec<_> = self.actions.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let handlers: Vec<_> = self.actions.read().unwrap().iter().cloned().collect();

        fn normalize_action_name(s: &str) -> String {
            s.to_lowercase().replace('_', "")
        }

        let mut results: Vec<ActionResult> = Vec::new();
        for name in to_run {
            let normalized = normalize_action_name(&name);

            let handler = handlers.iter().find(|h| {
                let def = h.definition();
                let def_norm = normalize_action_name(&def.name);
                if def_norm == normalized {
                    return true;
                }
                if let Some(similes) = &def.similes {
                    return similes
                        .iter()
                        .any(|s| normalize_action_name(s) == normalized);
                }
                false
            });

            let Some(handler) = handler else {
                results.push(ActionResult::failure(&format!("Action not found: {}", name)));
                continue;
            };

            if !handler.validate(message, Some(state)).await {
                continue;
            }

            let mut opts = HandlerOptions::default();
            let key = name.trim().to_uppercase();
            if let Some(p) = action_params.get(&key) {
                opts.parameters = Some(p.clone());
            }

            match handler.handle(message, Some(state), Some(&opts)).await {
                Ok(Some(r)) => results.push(r),
                Ok(None) => {}
                Err(e) => results.push(ActionResult::failure(&e.to_string())),
            }
        }

        Ok(results)
    }

    /// Run evaluators for a message (TypeScript/Python parity).
    pub async fn evaluate_message(
        &self,
        message: &Memory,
        state: &State,
    ) -> Result<Vec<ActionResult>> {
        // Clone to avoid holding lock across await
        #[cfg(not(feature = "wasm"))]
        let evaluators: Vec<_> = self.evaluators.read().await.iter().cloned().collect();
        #[cfg(feature = "wasm")]
        let evaluators: Vec<_> = self.evaluators.read().unwrap().iter().cloned().collect();

        let mut results: Vec<ActionResult> = Vec::new();
        for evaluator in evaluators.iter() {
            if !evaluator.validate(message, Some(state)).await {
                continue;
            }
            match evaluator.handle(message, Some(state), None).await {
                Ok(Some(r)) => results.push(r),
                Ok(None) => {}
                Err(e) => results.push(ActionResult::failure(&e.to_string())),
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

    /// Set the current trajectory step ID for tracing (benchmarks/training).
    pub fn set_trajectory_step_id(&self, step_id: Option<String>) {
        let mut current = self
            .current_trajectory_step_id
            .lock()
            .expect("lock poisoned");
        *current = step_id;
    }

    /// Get the current trajectory step ID for tracing (benchmarks/training).
    pub fn get_trajectory_step_id(&self) -> Option<String> {
        let current = self
            .current_trajectory_step_id
            .lock()
            .expect("lock poisoned");
        current.clone()
    }

    /// Get a snapshot of collected trajectory logs.
    pub fn get_trajectory_logs(&self) -> TrajectoryLogs {
        let guard = self.trajectory_logs.lock().expect("lock poisoned");
        guard.clone()
    }

    /// Get a reference to the database adapter (if any)
    pub fn get_adapter(&self) -> Option<&Arc<dyn DatabaseAdapter>> {
        self.adapter.as_ref()
    }

    /// Get a message service for handling incoming messages
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
    pub async fn use_model(&self, model_type: &str, params: serde_json::Value) -> Result<String> {
        use crate::types::model::model_type;

        // Apply LLM mode override for text generation models
        let llm_mode = self.get_llm_mode().await;
        let effective_model_type = if llm_mode != LLMMode::Default {
            // List of text generation model types that can be overridden
            let text_generation_models = [
                model_type::TEXT_SMALL,
                model_type::TEXT_LARGE,
                model_type::TEXT_REASONING_SMALL,
                model_type::TEXT_REASONING_LARGE,
                model_type::TEXT_COMPLETION,
            ];

            if text_generation_models.contains(&model_type) {
                let override_model = match llm_mode {
                    LLMMode::Small => model_type::TEXT_SMALL,
                    LLMMode::Large => model_type::TEXT_LARGE,
                    LLMMode::Default => model_type,
                };
                if model_type != override_model {
                    debug!(
                        "LLM mode override applied: {} -> {} (mode: {:?})",
                        model_type, override_model, llm_mode
                    );
                }
                override_model
            } else {
                model_type
            }
        } else {
            model_type
        };

        let handler = {
            #[cfg(not(feature = "wasm"))]
            {
                let handlers = self.model_handlers.read().await;
                handlers.get(effective_model_type).map(|h| {
                    // We need to call the handler - create a boxed future
                    h(params.clone())
                })
            }
            #[cfg(feature = "wasm")]
            {
                let handlers = self.model_handlers.read().unwrap();
                handlers
                    .get(effective_model_type)
                    .map(|h| h(params.clone()))
            }
        };

        let start_ms = chrono_timestamp();
        let result = match handler {
            Some(future) => future.await,
            None => Err(anyhow::anyhow!(
                "No model handler registered for type: {}. Register a model handler using register_model() or pass a plugin with model handlers.",
                effective_model_type
            )),
        };

        // Trajectory logging (best-effort; must never break core model flow)
        if let Ok(ref response_text) = result {
            if let Some(step_id) = self.get_trajectory_step_id() {
                let end_ms = chrono_timestamp();
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(2000)
                    .collect::<String>();
                let system_prompt = params
                    .get("system")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(2000)
                    .collect::<String>();
                let temperature = params.get("temperature").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let max_tokens = params.get("maxTokens").and_then(|v| v.as_i64()).unwrap_or(0);

                let mut logs = self.trajectory_logs.lock().expect("lock poisoned");
                logs.llm_calls.push(TrajectoryLlmCall {
                    step_id,
                    model: effective_model_type.to_string(),
                    system_prompt,
                    user_prompt: prompt,
                    response: response_text.chars().take(2000).collect::<String>(),
                    temperature,
                    max_tokens,
                    purpose: "action".to_string(),
                    action_type: "runtime.use_model".to_string(),
                    latency_ms: (end_ms - start_ms).max(0),
                    timestamp_ms: end_ms,
                });
            }
        }

        result
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

    // ============================================================================
    // Dynamic Prompt Execution with Validation-Aware Streaming
    // ============================================================================

    /// Dynamic prompt execution with state injection, schema-based parsing, and validation-aware streaming.
    ///
    /// WHY THIS EXISTS:
    /// LLMs are powerful but unreliable for structured outputs. They can:
    /// - Silently truncate output when hitting token limits
    /// - Skip fields or produce malformed structures
    /// - Hallucinate or ignore parts of the prompt
    ///
    /// This method addresses these issues by:
    /// 1. Validation codes: Injects UUID codes the LLM must echo back
    /// 2. Streaming with safety: Enables streaming while detecting truncation
    /// 3. Performance tracking: Tracks success/failure rates per model+schema
    ///
    /// # Arguments
    /// * `state` - State object to inject into the prompt template
    /// * `prompt` - Prompt template string (Handlebars syntax)
    /// * `schema` - Array of field definitions for structured output
    /// * `options` - Configuration for model size, validation level, retries, etc.
    ///
    /// # Returns
    /// Parsed structured response as JSON Value, or None on failure
    pub async fn dynamic_prompt_exec_from_state(
        &self,
        state: &State,
        prompt: &str,
        schema: &[crate::types::state::SchemaRow],
        options: DynamicPromptOptions,
    ) -> Result<Option<serde_json::Value>> {
        use crate::types::model::model_type;
        use uuid::Uuid;

        // Determine model type - check options.model first, then model_size, then default
        let model_type_str = if let Some(ref model) = options.model {
            model.as_str()
        } else {
            match options.model_size {
                Some(ModelSize::Small) => model_type::TEXT_SMALL,
                Some(ModelSize::Large) => model_type::TEXT_LARGE,
                None => model_type::TEXT_LARGE,
            }
        };

        let schema_key = schema.iter().map(|s| s.field.as_str()).collect::<Vec<_>>().join(",");
        let model_schema_key = format!("{}:{}", model_type_str, schema_key);

        // Get validation level
        let validation_level = options.context_check_level.unwrap_or(2);
        let max_retries = options.max_retries.unwrap_or(1);
        let mut current_retry = 0;

        // Generate per-field validation codes for levels 0-1
        let mut per_field_codes: HashMap<String, String> = HashMap::new();
        if validation_level <= 1 {
            for row in schema {
                let default_validate = validation_level == 1;
                let needs_validation = row.validate_field.unwrap_or(default_validate);
                if needs_validation {
                    per_field_codes.insert(row.field.clone(), Uuid::new_v4().to_string()[..8].to_string());
                }
            }
        }

        while current_retry <= max_retries {
            // Compile template with state values
            let state_map = state.values_map();
            let mut rendered = prompt.to_string();
            for (key, value) in &state_map {
                let placeholder = format!("{{{{{}}}}}", key);
                let value_str = match value {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                rendered = rendered.replace(&placeholder, &value_str);
            }

            // Build format
            let format = options.force_format.as_deref().unwrap_or("xml").to_uppercase();
            let is_xml = format == "XML";
            let container_start = if is_xml { "<response>" } else { "{" };
            let container_end = if is_xml { "</response>" } else { "}" };

            // Build extended schema with validation codes
            let first = validation_level >= 2;
            let last = validation_level >= 3;

            let mut ext_schema: Vec<(String, String)> = Vec::new();

            let codes_schema = |prefix: &str| -> Vec<(String, String)> {
                vec![
                    (format!("{}initial_code", prefix), "echo the initial UUID code from prompt".to_string()),
                    (format!("{}middle_code", prefix), "echo the middle UUID code from prompt".to_string()),
                    (format!("{}end_code", prefix), "echo the end UUID code from prompt".to_string()),
                ]
            };

            if first {
                ext_schema.extend(codes_schema("one_"));
            }

            for row in schema {
                if let Some(code) = per_field_codes.get(&row.field) {
                    ext_schema.push((format!("code_{}_start", row.field), format!("output exactly: {}", code)));
                }
                ext_schema.push((row.field.clone(), row.description.clone()));
                if let Some(code) = per_field_codes.get(&row.field) {
                    ext_schema.push((format!("code_{}_end", row.field), format!("output exactly: {}", code)));
                }
            }

            if last {
                ext_schema.extend(codes_schema("two_"));
            }

            // Build example
            let mut example = format!("{}\n", container_start);
            let ext_schema_len = ext_schema.len();
            for (i, (field, desc)) in ext_schema.iter().enumerate() {
                let is_last = i == ext_schema_len - 1;
                if is_xml {
                    example.push_str(&format!("  <{}>{}</{}>\n", field, desc, field));
                } else {
                    // No trailing comma on last field for valid JSON
                    let comma = if is_last { "" } else { "," };
                    example.push_str(&format!("  \"{}\": \"{}\"{}\n", field, desc, comma));
                }
            }
            example.push_str(container_end);

            let init_code = Uuid::new_v4().to_string();
            let mid_code = Uuid::new_v4().to_string();
            let final_code = Uuid::new_v4().to_string();

            let section_start = if is_xml { "<output>" } else { "# Strict Output instructions" };
            let section_end = if is_xml { "</output>" } else { "" };

            let full_prompt = format!(
                "initial code: {}\n{}\nmiddle code: {}\n{}\n\
                Do NOT include any thinking, reasoning, or <think> sections in your response.\n\
                Go directly to the {} response format without any preamble or explanation.\n\n\
                Respond using {} format like this:\n{}\n\n\
                IMPORTANT: Your response must ONLY contain the {}{} {} block above. \
                Do not include any text, thinking, or reasoning before or after this {} block. \
                Start your response immediately with {} and end with {}.\n\
                {}\nend code: {}\n",
                init_code, rendered, mid_code, section_start,
                format, format, example,
                container_start, container_end, format, format,
                container_start, container_end,
                section_end, final_code
            );

            debug!("dynamic_prompt_exec_from_state: using format {}", format);

            // Call model
            let params = serde_json::json!({
                "prompt": full_prompt,
                "maxTokens": 4096,
            });

            let response = match self.use_model(model_type_str, params).await {
                Ok(r) => r,
                Err(e) => {
                    error!("Model call failed: {}", e);
                    current_retry += 1;
                    if current_retry <= max_retries {
                        if let Some(backoff) = &options.retry_backoff {
                            let delay = backoff.delay_for_retry(current_retry);
                            debug!("Retry backoff: waiting {}ms before retry {}", delay, current_retry);
                            #[cfg(not(feature = "wasm"))]
                            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        }
                    }
                    continue;
                }
            };

            // Clean response (remove <think> blocks)
            let clean_response = {
                let mut result = response.clone();
                while let Some(start) = result.find("<think>") {
                    if let Some(end) = result.find("</think>") {
                        result = format!("{}{}", &result[..start], &result[end + 8..]);
                    } else {
                        break;
                    }
                }
                result
            };

            // Parse response
            let response_content: Option<serde_json::Value> = if is_xml {
                parse_xml_to_json(&clean_response)
            } else {
                serde_json::from_str(&clean_response).ok()
            };

            let mut all_good = true;
            let mut parsed = response_content.clone();

            if let Some(ref content) = parsed {
                // Validate codes based on context level
                if validation_level <= 1 {
                    // Per-field validation
                    for (field, expected_code) in &per_field_codes {
                        let start_code_field = format!("code_{}_start", field);
                        let end_code_field = format!("code_{}_end", field);
                        let start_code = content.get(&start_code_field).and_then(|v| v.as_str());
                        let end_code = content.get(&end_code_field).and_then(|v| v.as_str());

                        if start_code != Some(expected_code.as_str()) || end_code != Some(expected_code.as_str()) {
                            warn!("Per-field validation failed for {}: expected={}, start={:?}, end={:?}",
                                field, expected_code, start_code, end_code);
                            all_good = false;
                        }
                    }
                } else {
                    // Checkpoint validation
                    let validation_codes = [
                        (first, "one_initial_code", &init_code),
                        (first, "one_middle_code", &mid_code),
                        (first, "one_end_code", &final_code),
                        (last, "two_initial_code", &init_code),
                        (last, "two_middle_code", &mid_code),
                        (last, "two_end_code", &final_code),
                    ];

                    for (enabled, field, expected) in &validation_codes {
                        if *enabled {
                            let actual = content.get(*field).and_then(|v| v.as_str());
                            if actual != Some(*expected) {
                                warn!("Checkpoint {} mismatch: expected {}", field, expected);
                                all_good = false;
                            }
                        }
                    }
                }

                // Validate required fields
                if let Some(ref required_fields) = options.required_fields {
                    for field in required_fields {
                        let value = content.get(field);
                        let is_missing = match value {
                            None => true,
                            Some(serde_json::Value::Null) => true,
                            Some(serde_json::Value::String(s)) => s.trim().is_empty(),
                            Some(serde_json::Value::Array(a)) => a.is_empty(),
                            Some(serde_json::Value::Object(o)) => o.is_empty(),
                            _ => false,
                        };
                        if is_missing {
                            warn!("Missing required field: {}", field);
                            all_good = false;
                        }
                    }
                }

                // Clean up validation code fields from result
                if let Some(serde_json::Value::Object(ref mut obj)) = parsed {
                    // Remove per-field codes
                    for field in per_field_codes.keys() {
                        obj.remove(&format!("code_{}_start", field));
                        obj.remove(&format!("code_{}_end", field));
                    }
                    // Remove checkpoint codes
                    if first {
                        obj.remove("one_initial_code");
                        obj.remove("one_middle_code");
                        obj.remove("one_end_code");
                    }
                    if last {
                        obj.remove("two_initial_code");
                        obj.remove("two_middle_code");
                        obj.remove("two_end_code");
                    }
                }
            } else {
                warn!("dynamic_prompt_exec_from_state parse problem: {}", clean_response);
                all_good = false;
            }

            if all_good {
                debug!("dynamic_prompt_exec_from_state success [{}]", model_schema_key);
                return Ok(parsed);
            }

            current_retry += 1;

            if current_retry <= max_retries {
                if let Some(backoff) = &options.retry_backoff {
                    let delay = backoff.delay_for_retry(current_retry);
                    debug!("Retry backoff: waiting {}ms before retry {}", delay, current_retry);
                    #[cfg(not(feature = "wasm"))]
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
        }

        error!("dynamic_prompt_exec_from_state failed after {} retries [{}]", max_retries, model_schema_key);
        Ok(None)
    }
}

/// Options for dynamic prompt execution.
#[derive(Debug, Clone, Default)]
pub struct DynamicPromptOptions {
    /// Model size to use (small or large)
    pub model_size: Option<ModelSize>,
    /// Specific model identifier override
    pub model: Option<String>,
    /// Force output format (json or xml)
    pub force_format: Option<String>,
    /// Required fields that must be present and non-empty
    pub required_fields: Option<Vec<String>>,
    /// Validation level (0=trusted, 1=progressive, 2=checkpoint, 3=full)
    pub context_check_level: Option<u8>,
    /// Maximum retry attempts
    pub max_retries: Option<u32>,
    /// Retry backoff configuration
    pub retry_backoff: Option<crate::types::state::RetryBackoffConfig>,
}

/// Model size selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelSize {
    Small,
    Large,
}

/// Parse XML-like response to JSON.
fn parse_xml_to_json(xml: &str) -> Option<serde_json::Value> {
    use std::collections::HashMap;

    let mut result: HashMap<String, serde_json::Value> = HashMap::new();

    // Simple XML tag extraction
    let mut remaining = xml;
    while let Some(open_start) = remaining.find('<') {
        let after_open = &remaining[open_start + 1..];
        if let Some(open_end) = after_open.find('>') {
            let tag_name = &after_open[..open_end];
            // Skip closing tags, comments, and special tags
            if tag_name.starts_with('/') || tag_name.starts_with('!') || tag_name.starts_with('?') {
                remaining = &after_open[open_end + 1..];
                continue;
            }
            // Remove attributes if any
            let tag_name = tag_name.split_whitespace().next().unwrap_or(tag_name);

            let close_tag = format!("</{}>", tag_name);
            let content_start = open_start + 1 + open_end + 1;
            if let Some(close_pos) = remaining[content_start..].find(&close_tag) {
                let content = &remaining[content_start..content_start + close_pos];
                result.insert(tag_name.to_string(), serde_json::Value::String(content.trim().to_string()));
                remaining = &remaining[content_start + close_pos + close_tag.len()..];
            } else {
                remaining = &after_open[open_end + 1..];
            }
        } else {
            break;
        }
    }

    if result.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(result.into_iter().collect()))
    }
}

/// Get current timestamp in milliseconds.
fn chrono_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn parse_truthy_setting(v: Option<SettingValue>) -> bool {
    match v {
        Some(SettingValue::Bool(b)) => b,
        Some(SettingValue::String(s)) => {
            let t = s.trim().to_lowercase();
            matches!(t.as_str(), "true" | "1" | "yes" | "on")
        }
        Some(SettingValue::Number(n)) => n != 0.0,
        Some(SettingValue::Null) | None => false,
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

        #[cfg(feature = "native")]
        {
            let character_guard = runtime.character.read().await;
            let character = character_guard.clone();
            assert_eq!(character.name, "TestAgent");
        }
        #[cfg(not(feature = "native"))]
        {
            let character_guard = runtime.character.read().unwrap();
            let character = character_guard.clone();
            assert_eq!(character.name, "TestAgent");
        }
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
            .set_setting(
                "FLAG_FALSE",
                SettingValue::String("false".to_string()),
                false,
            )
            .await;

        assert_eq!(
            runtime.get_setting("FLAG_TRUE").await,
            Some(SettingValue::Bool(true))
        );
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

    #[tokio::test]
    async fn test_default_log_level_is_error() {
        let runtime = AgentRuntime::new(RuntimeOptions::default()).await.unwrap();
        assert_eq!(runtime.log_level(), LogLevel::Error);
    }

    #[tokio::test]
    async fn test_advanced_planning_service_gated_on_character_flag() {
        let runtime_enabled = AgentRuntime::new(RuntimeOptions {
            character: Some(Character {
                name: "AdvPlanningOn".to_string(),
                advanced_planning: Some(true),
                bio: Bio::Single("Test".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
        runtime_enabled.initialize().await.unwrap();
        assert!(runtime_enabled.get_service("planning").await.is_some());

        let runtime_disabled = AgentRuntime::new(RuntimeOptions {
            character: Some(Character {
                name: "AdvPlanningOff".to_string(),
                advanced_planning: Some(false),
                bio: Bio::Single("Test".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
        runtime_disabled.initialize().await.unwrap();
        assert!(runtime_disabled.get_service("planning").await.is_none());
    }

    #[tokio::test]
    async fn test_custom_log_level_info() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            log_level: LogLevel::Info,
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(runtime.log_level(), LogLevel::Info);
    }

    #[tokio::test]
    async fn test_custom_log_level_debug() {
        let runtime = AgentRuntime::new(RuntimeOptions {
            log_level: LogLevel::Debug,
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(runtime.log_level(), LogLevel::Debug);
    }

    #[test]
    fn test_log_level_to_tracing() {
        assert_eq!(LogLevel::Trace.to_tracing_level(), tracing::Level::TRACE);
        assert_eq!(LogLevel::Debug.to_tracing_level(), tracing::Level::DEBUG);
        assert_eq!(LogLevel::Info.to_tracing_level(), tracing::Level::INFO);
        assert_eq!(LogLevel::Warn.to_tracing_level(), tracing::Level::WARN);
        assert_eq!(LogLevel::Error.to_tracing_level(), tracing::Level::ERROR);
        assert_eq!(LogLevel::Fatal.to_tracing_level(), tracing::Level::ERROR);
    }
}
