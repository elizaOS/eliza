//! elizaOS A2A (Agent-to-Agent) Server - Rust
//!
//! An HTTP server that exposes an elizaOS agent for agent-to-agent communication.
//! Uses real elizaOS runtime.
//!
//! - With `OPENAI_API_KEY`: uses OpenAI plugin
//! - Without `OPENAI_API_KEY`: registers a classic ELIZA model handler (no API keys required)

use anyhow::Result;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Sse},
    routing::{get, post},
    Json, Router,
};
use elizaos::{
    Agent, Entity, GetMemoriesParams,
    parse_character,
    runtime::{AgentRuntime, DatabaseAdapter, RuntimeOptions},
    types::{Content, HandlerCallback, Memory, UUID},
    Room, SearchMemoriesParams, Task, World,
};
use elizaos::services::IMessageService;
use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
};
use tokio::sync::OnceCell;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

// ============================================================================
// Configuration
// ============================================================================

const CHARACTER_JSON: &str = r#"{
    "name": "Eliza",
    "settings": {
        "model": "gpt-4o",
        "embeddingModel": "text-embedding-3-small"
    },
    "bio": "A helpful AI assistant powered by elizaOS, available via A2A protocol.",
    "system": "You are a helpful, friendly AI assistant participating in agent-to-agent communication. Be concise, informative, and cooperative."
}"#;

fn has_openai_key() -> bool {
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

fn extract_user_text(prompt: &str) -> &str {
    for line in prompt.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("User:") {
            return rest.trim();
        }
        if let Some(rest) = trimmed.strip_prefix("Human:") {
            return rest.trim();
        }
        if let Some(rest) = trimmed.strip_prefix("You:") {
            return rest.trim();
        }
    }
    prompt.trim()
}

// ============================================================================
// In-memory DatabaseAdapter (plugin-inmemorydb-backed) for multi-turn state
// ============================================================================

use elizaos_plugin_inmemorydb::{IStorage, MemoryStorage, COLLECTIONS as IM_COLLECTIONS};

#[derive(Clone)]
struct InMemoryDbAdapter {
    storage: Arc<MemoryStorage>,
}

impl Default for InMemoryDbAdapter {
    fn default() -> Self {
        Self {
            storage: Arc::new(MemoryStorage::new()),
        }
    }
}

fn storage_err(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!(e.to_string())
}

fn insert_table_name(mut value: serde_json::Value, table_name: &str) -> serde_json::Value {
    if let Some(obj) = value.as_object_mut() {
        // Store table_name in metadata.type for compatibility with plugin-inmemorydb
        let metadata = obj.entry("metadata".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if let Some(meta_obj) = metadata.as_object_mut() {
            meta_obj.insert("type".to_string(), serde_json::Value::String(table_name.to_string()));
        }
    }
    value
}

fn get_table_name(value: &serde_json::Value) -> Option<&str> {
    value.get("metadata")
        .and_then(|m| m.get("type"))
        .and_then(|v| v.as_str())
}

#[async_trait::async_trait]
impl DatabaseAdapter for InMemoryDbAdapter {
    async fn init(&self) -> Result<()> {
        self.storage.init().await.map_err(storage_err)
    }

    async fn close(&self) -> Result<()> {
        self.storage.close().await.map_err(storage_err)
    }

    async fn is_ready(&self) -> Result<bool> {
        Ok(self.storage.is_ready().await)
    }

    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>> {
        let raw = self
            .storage
            .get(IM_COLLECTIONS::AGENTS, &agent_id.to_string())
            .await
            .map_err(storage_err)?;
        match raw {
            None => Ok(None),
            Some(v) => Ok(Some(serde_json::from_value(v)?)),
        }
    }

    async fn create_agent(&self, agent: &Agent) -> Result<bool> {
        let id = agent.character.id.clone().unwrap_or_else(UUID::new_v4);
        self.storage
            .set(
                IM_COLLECTIONS::AGENTS,
                &id.to_string(),
                serde_json::to_value(agent)?,
            )
            .await
            .map_err(storage_err)?;
        Ok(true)
    }

    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool> {
        self.storage
            .set(
                IM_COLLECTIONS::AGENTS,
                &agent_id.to_string(),
                serde_json::to_value(agent)?,
            )
            .await
            .map_err(storage_err)?;
        Ok(true)
    }

    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool> {
        self.storage
            .delete(IM_COLLECTIONS::AGENTS, &agent_id.to_string())
            .await
            .map_err(storage_err)
    }

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        let mut values = self
            .storage
            .get_all(IM_COLLECTIONS::MEMORIES)
            .await
            .map_err(storage_err)?;

        // Filter by table_name (stored as __tableName)
        values.retain(|v| get_table_name(v) == Some(params.table_name.as_str()));

        if let Some(room_id) = &params.room_id {
            values.retain(|v| v.get("roomId").and_then(|x| x.as_str()) == Some(&room_id.to_string()));
        }
        if let Some(world_id) = &params.world_id {
            values.retain(|v| v.get("worldId").and_then(|x| x.as_str()) == Some(&world_id.to_string()));
        }
        if let Some(entity_id) = &params.entity_id {
            values.retain(|v| v.get("entityId").and_then(|x| x.as_str()) == Some(&entity_id.to_string()));
        }
        if let Some(agent_id) = &params.agent_id {
            values.retain(|v| v.get("agentId").and_then(|x| x.as_str()) == Some(&agent_id.to_string()));
        }
        if let Some(start) = params.start {
            values.retain(|v| v.get("createdAt").and_then(|x| x.as_i64()).unwrap_or(0) >= start);
        }
        if let Some(end) = params.end {
            values.retain(|v| v.get("createdAt").and_then(|x| x.as_i64()).unwrap_or(0) <= end);
        }
        if params.unique == Some(true) {
            values.retain(|v| v.get("unique").and_then(|x| x.as_bool()) == Some(true));
        }

        values.sort_by(|a, b| {
            let a_time = a.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            let b_time = b.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            b_time.cmp(&a_time)
        });

        let offset = params.offset.unwrap_or(0).max(0) as usize;
        let count = params.count.unwrap_or(50).max(0) as usize;
        let values = values.into_iter().skip(offset).take(count);

        let mut out: Vec<Memory> = Vec::new();
        for mut v in values {
            if let Some(obj) = v.as_object_mut() {
                obj.remove("__tableName");
            }
            out.push(serde_json::from_value(v)?);
        }
        Ok(out)
    }

    async fn search_memories(&self, params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        // Basic fallback search: filter by table_name and other params, return most recent
        // Note: This is a simplified implementation without vector similarity search.
        // For production, integrate with a proper vector index.
        let mut values = self
            .storage
            .get_all(IM_COLLECTIONS::MEMORIES)
            .await
            .map_err(storage_err)?;

        // Filter by table_name
        values.retain(|v| get_table_name(v) == Some(params.table_name.as_str()));

        // Apply filters
        if let Some(room_id) = &params.room_id {
            values.retain(|v| v.get("roomId").and_then(|x| x.as_str()) == Some(&room_id.to_string()));
        }
        if let Some(world_id) = &params.world_id {
            values.retain(|v| v.get("worldId").and_then(|x| x.as_str()) == Some(&world_id.to_string()));
        }
        if let Some(entity_id) = &params.entity_id {
            values.retain(|v| v.get("entityId").and_then(|x| x.as_str()) == Some(&entity_id.to_string()));
        }
        if params.unique == Some(true) {
            values.retain(|v| v.get("unique").and_then(|x| x.as_bool()) == Some(true));
        }

        // Sort by creation time (most recent first)
        values.sort_by(|a, b| {
            let a_time = a.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            let b_time = b.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
            b_time.cmp(&a_time)
        });

        // Limit results
        let count = params.count.unwrap_or(10) as usize;
        let values = values.into_iter().take(count);

        let mut out: Vec<Memory> = Vec::new();
        for mut v in values {
            if let Some(obj) = v.as_object_mut() {
                obj.remove("__tableName"); // Clean up legacy field if present
            }
            if let Ok(mem) = serde_json::from_value(v) {
                out.push(mem);
            }
        }
        Ok(out)
    }

    async fn create_memory(&self, memory: &Memory, table_name: &str) -> Result<UUID> {
        let mut stored = memory.clone();
        let id = stored.id.clone().unwrap_or_else(UUID::new_v4);
        stored.id = Some(id.clone());
        if stored.created_at.is_none() {
            stored.created_at = Some(chrono::Utc::now().timestamp_millis());
        }

        let value = insert_table_name(serde_json::to_value(&stored)?, table_name);
        self.storage
            .set(IM_COLLECTIONS::MEMORIES, &id.to_string(), value)
            .await
            .map_err(storage_err)?;
        Ok(id)
    }

    async fn update_memory(&self, memory: &Memory) -> Result<bool> {
        let Some(id) = &memory.id else {
            return Ok(false);
        };
        // Preserve the existing table name from metadata, default to "messages" if not present
        let table_name = memory.metadata
            .as_ref()
            .and_then(|m| match m {
                elizaos::MemoryMetadata::Custom(v) => v.get("type").and_then(|t| t.as_str()),
            })
            .unwrap_or("messages");
        let value = insert_table_name(serde_json::to_value(memory)?, table_name);
        self.storage
            .set(IM_COLLECTIONS::MEMORIES, &id.to_string(), value)
            .await
            .map_err(storage_err)?;
        Ok(true)
    }

    async fn delete_memory(&self, memory_id: &UUID) -> Result<()> {
        let _ = self
            .storage
            .delete(IM_COLLECTIONS::MEMORIES, &memory_id.to_string())
            .await
            .map_err(storage_err)?;
        Ok(())
    }

    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>> {
        let raw = self
            .storage
            .get(IM_COLLECTIONS::MEMORIES, &id.to_string())
            .await
            .map_err(storage_err)?;
        match raw {
            None => Ok(None),
            Some(mut v) => {
                if let Some(obj) = v.as_object_mut() {
                    obj.remove("__tableName");
                }
                Ok(Some(serde_json::from_value(v)?))
            }
        }
    }

    async fn create_world(&self, world: &World) -> Result<UUID> {
        self.storage
            .set(
                IM_COLLECTIONS::WORLDS,
                &world.id.to_string(),
                serde_json::to_value(world)?,
            )
            .await
            .map_err(storage_err)?;
        Ok(world.id.clone())
    }

    async fn get_world(&self, id: &UUID) -> Result<Option<World>> {
        let raw = self
            .storage
            .get(IM_COLLECTIONS::WORLDS, &id.to_string())
            .await
            .map_err(storage_err)?;
        match raw {
            None => Ok(None),
            Some(v) => Ok(Some(serde_json::from_value(v)?)),
        }
    }

    async fn create_room(&self, room: &Room) -> Result<UUID> {
        self.storage
            .set(
                IM_COLLECTIONS::ROOMS,
                &room.id.to_string(),
                serde_json::to_value(room)?,
            )
            .await
            .map_err(storage_err)?;
        Ok(room.id.clone())
    }

    async fn get_room(&self, id: &UUID) -> Result<Option<Room>> {
        let raw = self
            .storage
            .get(IM_COLLECTIONS::ROOMS, &id.to_string())
            .await
            .map_err(storage_err)?;
        match raw {
            None => Ok(None),
            Some(v) => Ok(Some(serde_json::from_value(v)?)),
        }
    }

    async fn create_entity(&self, entity: &Entity) -> Result<bool> {
        let Some(id) = entity.id.clone() else {
            return Ok(false);
        };
        self.storage
            .set(
                IM_COLLECTIONS::ENTITIES,
                &id.to_string(),
                serde_json::to_value(entity)?,
            )
            .await
            .map_err(storage_err)?;
        Ok(true)
    }

    async fn get_entity(&self, id: &UUID) -> Result<Option<Entity>> {
        let raw = self
            .storage
            .get(IM_COLLECTIONS::ENTITIES, &id.to_string())
            .await
            .map_err(storage_err)?;
        match raw {
            None => Ok(None),
            Some(v) => Ok(Some(serde_json::from_value(v)?)),
        }
    }

    async fn add_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool> {
        let key = format!("{}:{}", room_id, entity_id);
        self.storage
            .set(
                IM_COLLECTIONS::PARTICIPANTS,
                &key,
                serde_json::json!({
                    "roomId": room_id.to_string(),
                    "entityId": entity_id.to_string()
                }),
            )
            .await
            .map_err(storage_err)?;
        Ok(true)
    }

    async fn create_task(&self, task: &Task) -> Result<UUID> {
        let id = task.id.clone().unwrap_or_else(UUID::new_v4);
        self.storage
            .set(
                IM_COLLECTIONS::TASKS,
                &id.to_string(),
                serde_json::to_value(task)?,
            )
            .await
            .map_err(storage_err)?;
        Ok(id)
    }

    async fn get_task(&self, id: &UUID) -> Result<Option<Task>> {
        let raw = self
            .storage
            .get(IM_COLLECTIONS::TASKS, &id.to_string())
            .await
            .map_err(storage_err)?;
        match raw {
            None => Ok(None),
            Some(v) => Ok(Some(serde_json::from_value(v)?)),
        }
    }

    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()> {
        self.storage
            .set(
                IM_COLLECTIONS::TASKS,
                &id.to_string(),
                serde_json::to_value(task)?,
            )
            .await
            .map_err(storage_err)?;
        Ok(())
    }

    async fn delete_task(&self, id: &UUID) -> Result<()> {
        let _ = self
            .storage
            .delete(IM_COLLECTIONS::TASKS, &id.to_string())
            .await
            .map_err(storage_err)?;
        Ok(())
    }
}

// ============================================================================
// Request/Response Types
// ============================================================================

#[derive(Debug, Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    context: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    response: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    timestamp: String,
}

#[derive(Debug, Serialize)]
struct AgentInfo {
    name: String,
    bio: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    version: String,
    capabilities: Vec<String>,
    powered_by: String,
    mode: String,
    endpoints: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    agent: String,
    timestamp: String,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

// ============================================================================
// App State
// ============================================================================

struct Session {
    room_id: UUID,
    user_id: UUID,
}

struct AppState {
    runtime: OnceCell<Arc<AgentRuntime>>,
    sessions: tokio::sync::RwLock<HashMap<String, Session>>,
    character_name: String,
    character_bio: String,
}

impl AppState {
    fn new() -> Self {
        Self {
            runtime: OnceCell::const_new(),
            sessions: tokio::sync::RwLock::new(HashMap::new()),
            character_name: "Eliza".to_string(),
            character_bio: "A helpful AI assistant powered by elizaOS, available via A2A protocol."
                .to_string(),
        }
    }

    async fn get_runtime(&self) -> Result<Arc<AgentRuntime>> {
        self.runtime
            .get_or_try_init(|| async {
                info!("🚀 Initializing elizaOS runtime...");

                let character = parse_character(CHARACTER_JSON)?;

                let adapter: Arc<dyn DatabaseAdapter> = Arc::new(InMemoryDbAdapter::default());

                let mut plugins: Vec<elizaos::Plugin> = Vec::new();
                
                if has_openai_key() {
                   if let Ok(plugin) = create_openai_elizaos_plugin() {
                       // The OpenAI plugin might return struct or impl Plugin. 
                       // We assume it's compatible or we need Arc<dyn Plugin>?
                       // NOTE: AgentRuntime likely takes concrete struct if possible, or we need to be careful.
                       // create_openai_elizaos_plugin returns elizaos::Plugin struct usually.
                       plugins.push(plugin);
                   }
                }

                // Register local bootstrap actions
                let mut bootstrap = elizaos::Plugin::new("local-bootstrap", "Core actions");
                bootstrap = bootstrap
                    .with_action(std::sync::Arc::new(local_bootstrap::SimpleAction {
                        name: "REPLY".to_string(),
                        description: "Reply to the user".to_string(),
                        similes: vec!["RESPOND".to_string(), "ANSWER".to_string()],
                    }))
                    .with_action(std::sync::Arc::new(local_bootstrap::SimpleAction {
                        name: "NONE".to_string(),
                        description: "No action".to_string(),
                        similes: vec!["IGNORE".to_string(), "NO_ACTION".to_string()],
                    }));
                plugins.push(bootstrap);

                let runtime = AgentRuntime::new(RuntimeOptions {
                    character: Some(character),
                    plugins,
                    adapter: Some(adapter),
                    ..Default::default()
                })
                .await?;

                runtime.initialize().await?;

                if !has_openai_key() {
                    // Register a deterministic, no-API-keys model handler (classic ELIZA).
                    let eliza = Arc::new(ElizaClassicPlugin::new());

                    let eliza_large = eliza.clone();
                    runtime
                        .register_model(
                            "TEXT_LARGE",
                            Box::new(move |params: serde_json::Value| {
                                let eliza = eliza_large.clone();
                                Box::pin(async move {
                                    let prompt = params
                                        .get("prompt")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let user_text = extract_user_text(prompt);
                                    let response = eliza.generate_response(user_text);
                                    // Wrap in JSON as the runtime typically expects structured output for chat
                                    let json_response = serde_json::json!({
                                        "text": response, // The actual message content
                                        "action": "NONE"  // Explicitly telling runtime: "Just output the text, take no other action"
                                    });
                                    Ok(json_response.to_string())
                                })
                            }),
                        )
                        .await;

                    let eliza_small = eliza.clone();
                    runtime
                        .register_model(
                            "TEXT_SMALL",
                            Box::new(move |params: serde_json::Value| {
                                let eliza = eliza_small.clone();
                                Box::pin(async move {
                                    let prompt = params
                                        .get("prompt")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let user_text = extract_user_text(prompt);
                                    let response = eliza.generate_response(user_text);
                                    // Wrap in JSON as the runtime typically expects structured output for chat
                                    let json_response = serde_json::json!({
                                        "text": response, // The actual message content
                                        "action": "NONE"  // Explicitly telling runtime: "Just output the text, take no other action"
                                    });
                                    Ok(json_response.to_string())
                                })
                            }),
                        )
                        .await;
                }

                info!("✅ elizaOS runtime initialized");
                Ok(runtime)
            })
            .await
            .cloned()
    }

    async fn get_or_create_session(&self, session_id: &str) -> Session {
        let mut sessions = self.sessions.write().await;

        if let Some(session) = sessions.get(session_id) {
            return Session {
                room_id: session.room_id.clone(),
                user_id: session.user_id.clone(),
            };
        }

        let session = Session {
            room_id: UUID::new_v4(),
            user_id: UUID::new_v4(),
        };

        sessions.insert(
            session_id.to_string(),
            Session {
                room_id: session.room_id.clone(),
                user_id: session.user_id.clone(),
            },
        );

        session
    }
}

// ============================================================================
// Handlers
// ============================================================================

async fn agent_info(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let runtime = match state.get_runtime().await {
        Ok(rt) => rt,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    let mut endpoints = HashMap::new();
    endpoints.insert(
        "POST /chat".to_string(),
        "Send a message and receive a response".to_string(),
    );
    endpoints.insert(
        "POST /chat/stream".to_string(),
        "Stream a response (SSE)".to_string(),
    );
    endpoints.insert("GET /health".to_string(), "Health check endpoint".to_string());
    endpoints.insert("GET /".to_string(), "This info endpoint".to_string());

    Json(AgentInfo {
        name: state.character_name.clone(),
        bio: state.character_bio.clone(),
        agent_id: runtime.agent_id.to_string(),
        version: "1.0.0".to_string(),
        capabilities: vec![
            "chat".to_string(),
            "reasoning".to_string(),
            "multi-turn".to_string(),
        ],
        powered_by: "elizaOS".to_string(),
        mode: if has_openai_key() {
            "openai".to_string()
        } else {
            "eliza-classic".to_string()
        },
        endpoints,
    })
    .into_response()
}

async fn health_check(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.get_runtime().await {
        Ok(_) => Json(HealthResponse {
            status: "healthy".to_string(),
            agent: state.character_name.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
        .into_response(),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
            .into_response(),
    }
}

async fn chat(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChatRequest>,
) -> impl IntoResponse {
    if body.message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Message is required".to_string(),
            }),
        )
            .into_response();
    }

    let session_id = body.session_id.unwrap_or_else(|| {
        headers
            .get("x-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    });

    let runtime = match state.get_runtime().await {
        Ok(rt) => rt,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    let session = state.get_or_create_session(&session_id).await;

    let mut content = Content {
        text: Some(body.message),
        ..Default::default()
    };
    if let Some(agent_id) = headers
        .get("x-agent-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        content.extra.insert(
            "callerAgentId".to_string(),
            serde_json::Value::String(agent_id.to_string()),
        );
    }
    if let Some(ctx) = body.context {
        let ctx_map: serde_json::Map<String, serde_json::Value> = ctx.into_iter().collect();
        content
            .extra
            .insert("context".to_string(), serde_json::Value::Object(ctx_map));
    }
    let mut message = Memory::new(session.user_id, session.room_id, content);

    let result = match runtime
        .message_service()
        .handle_message(&runtime, &mut message, None, None)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    let raw_text = result
        .response_content
        .and_then(|c| c.text)
        .unwrap_or_else(|| "No response generated.".to_string());

    // Clean up response: if it's a JSON string (from local model handler), extract the text.
    let response_text = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw_text) {
        v.get("text")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .unwrap_or(raw_text)
    } else {
        raw_text
    };

    Json(ChatResponse {
        response: response_text,
        agent_id: runtime.agent_id.to_string(),
        session_id,
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
    .into_response()
}

async fn chat_stream(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ChatRequest>,
) -> impl IntoResponse {
    use axum::response::sse::{Event, KeepAlive};
    use futures::stream;
    use std::convert::Infallible;

    if body.message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Message is required".to_string(),
            }),
        )
            .into_response();
    }

    let session_id = body.session_id.unwrap_or_else(|| {
        headers
            .get("x-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    });

    let runtime = match state.get_runtime().await {
        Ok(rt) => rt,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
                .into_response();
        }
    };

    use tokio::sync::mpsc;
    use futures::FutureExt;

    #[derive(Debug)]
    enum StreamMsg {
        Text(String),
        Done,
        Error(String),
    }

    let session = state.get_or_create_session(&session_id).await;

    let mut content = Content {
        text: Some(body.message),
        ..Default::default()
    };
    if let Some(agent_id) = headers
        .get("x-agent-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        content.extra.insert(
            "callerAgentId".to_string(),
            serde_json::Value::String(agent_id.to_string()),
        );
    }
    if let Some(ctx) = body.context {
        let ctx_map: serde_json::Map<String, serde_json::Value> = ctx.into_iter().collect();
        content
            .extra
            .insert("context".to_string(), serde_json::Value::Object(ctx_map));
    }
    let mut message = Memory::new(session.user_id, session.room_id, content);

    let (tx, rx) = mpsc::channel::<StreamMsg>(32);
    let tx_cb = tx.clone();
    let callback: HandlerCallback = Box::new(move |content: Content| {
        let tx = tx_cb.clone();
        async move {
            if let Some(text) = content.text {
                let _ = tx.send(StreamMsg::Text(text)).await;
            }
            Vec::new()
        }
        .boxed()
    });

    let runtime_for_task = runtime.clone();
    tokio::spawn(async move {
        let result = runtime_for_task
            .message_service()
            .handle_message(&runtime_for_task, &mut message, Some(callback), None)
            .await;

        match result {
            Ok(_) => {
                let _ = tx.send(StreamMsg::Done).await;
            }
            Err(e) => {
                let _ = tx.send(StreamMsg::Error(e.to_string())).await;
            }
        }
    });

    let stream = stream::unfold(rx, |mut rx| async {
        match rx.recv().await {
            None => None,
            Some(StreamMsg::Text(text)) => Some((
                Ok::<_, Infallible>(Event::default().data(
                    serde_json::json!({"text": text}).to_string(),
                )),
                rx,
            )),
            Some(StreamMsg::Done) => Some((
                Ok::<_, Infallible>(Event::default().data(
                    serde_json::json!({"done": true}).to_string(),
                )),
                rx,
            )),
            Some(StreamMsg::Error(err)) => Some((
                Ok::<_, Infallible>(Event::default().data(
                    serde_json::json!({"error": err}).to_string(),
                )),
                rx,
            )),
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

// ============================================================================
// Local Bootstrap Implementation
// ============================================================================

mod local_bootstrap {
    use async_trait::async_trait;
    use elizaos::types::components::{ActionHandler, ActionDefinition, ActionResult, HandlerOptions};
    use elizaos::types::{Memory, State};
    use anyhow::Result;

    pub struct SimpleAction {
        pub name: String,
        pub description: String,
        pub similes: Vec<String>,
    }

    #[async_trait]
    impl ActionHandler for SimpleAction {
        fn definition(&self) -> ActionDefinition {
            ActionDefinition {
                name: self.name.clone(),
                description: self.description.clone(),
                similes: Some(self.similes.clone()),
                ..Default::default()
            }
        }

        async fn validate(&self, _message: &Memory, _state: Option<&State>) -> bool {
            true
        }

        async fn handle(
            &self,
            _message: &Memory,
            _state: Option<&State>,
            options: Option<&HandlerOptions>,
        ) -> Result<Option<ActionResult>, anyhow::Error> {
            let text = options
                .and_then(|o| o.parameters.as_ref())
                .and_then(|p| p.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("No content generated");

            Ok(Some(ActionResult::success_with_text(text)))
        }
    }
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    // Default OpenAI models to valid ones to prevent gpt-5 usage
    if std::env::var("OPENAI_LARGE_MODEL").is_err() {
        std::env::set_var("OPENAI_LARGE_MODEL", "gpt-4o");
    }
    if std::env::var("OPENAI_SMALL_MODEL").is_err() {
        std::env::set_var("OPENAI_SMALL_MODEL", "gpt-4o-mini");
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("eliza_a2a_server=info".parse().unwrap()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .unwrap_or(3000);

    let state = Arc::new(AppState::new());

    // Pre-initialize runtime
    state.get_runtime().await?;

    println!("\n🌐 elizaOS A2A Server (Axum)");
    println!("   http://localhost:{}\n", port);
    println!("📚 Endpoints:");
    println!("   GET  /            - Agent info");
    println!("   GET  /health      - Health check");
    println!("   POST /chat        - Chat with agent");
    println!("   POST /chat/stream - Stream response (SSE)\n");

    let app = build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/", get(agent_info))
        .route("/health", get(health_check))
        .route("/chat", post(chat))
        .route("/chat/stream", post(chat_stream))
        .layer(cors)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    #[tokio::test]
    async fn a2a_endpoints_work_without_openai() {
        // Ensure we run in eliza-classic mode for deterministic tests.
        std::env::remove_var("OPENAI_API_KEY");

        let state = Arc::new(AppState::new());
        let app = build_router(state);

        // GET /
        let res = app
            .clone()
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("Eliza"));

        // GET /health
        let res = app
            .clone()
            .oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // POST /chat
        let payload = serde_json::json!({ "message": "Hello!", "sessionId": "test-session" });
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/chat")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert!(v.get("response").and_then(|x| x.as_str()).is_some());
    }
}

