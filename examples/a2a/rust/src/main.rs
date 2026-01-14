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
use tokio::sync::RwLock;
use tokio::sync::OnceCell;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

// ============================================================================
// Configuration
// ============================================================================

const CHARACTER_JSON: &str = r#"{
    "name": "Eliza",
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
// Minimal in-memory DatabaseAdapter (for multi-turn state)
// ============================================================================

#[derive(Default)]
struct InMemoryAdapter {
    ready: RwLock<bool>,
    agents: RwLock<HashMap<UUID, Agent>>,
    entities: RwLock<HashMap<UUID, Entity>>,
    rooms: RwLock<HashMap<UUID, Room>>,
    worlds: RwLock<HashMap<UUID, World>>,
    memories: RwLock<HashMap<UUID, Memory>>,
    tasks: RwLock<HashMap<UUID, Task>>,
    participants: RwLock<HashMap<UUID, Vec<UUID>>>,
}

#[async_trait::async_trait]
impl DatabaseAdapter for InMemoryAdapter {
    async fn init(&self) -> Result<()> {
        let mut ready = self.ready.write().await;
        *ready = true;
        Ok(())
    }

    async fn close(&self) -> Result<()> {
        let mut ready = self.ready.write().await;
        *ready = false;
        Ok(())
    }

    async fn is_ready(&self) -> Result<bool> {
        Ok(*self.ready.read().await)
    }

    async fn get_agent(&self, agent_id: &UUID) -> Result<Option<Agent>> {
        Ok(self.agents.read().await.get(agent_id).cloned())
    }

    async fn create_agent(&self, agent: &Agent) -> Result<bool> {
        let id = agent.character.id.clone().unwrap_or_else(UUID::new_v4);
        self.agents.write().await.insert(id, agent.clone());
        Ok(true)
    }

    async fn update_agent(&self, agent_id: &UUID, agent: &Agent) -> Result<bool> {
        self.agents
            .write()
            .await
            .insert(agent_id.clone(), agent.clone());
        Ok(true)
    }

    async fn delete_agent(&self, agent_id: &UUID) -> Result<bool> {
        Ok(self.agents.write().await.remove(agent_id).is_some())
    }

    async fn get_memories(&self, params: GetMemoriesParams) -> Result<Vec<Memory>> {
        let count = params.count.unwrap_or(50).max(0) as usize;
        let offset = params.offset.unwrap_or(0).max(0) as usize;

        let mut items: Vec<Memory> = self
            .memories
            .read()
            .await
            .values()
            .filter(|m| {
                if let Some(room_id) = &params.room_id {
                    if &m.room_id != room_id {
                        return false;
                    }
                }
                if let Some(entity_id) = &params.entity_id {
                    if &m.entity_id != entity_id {
                        return false;
                    }
                }
                if let Some(agent_id) = &params.agent_id {
                    if m.agent_id.as_ref() != Some(agent_id) {
                        return false;
                    }
                }
                if let Some(start) = params.start {
                    if m.created_at.unwrap_or(0) < start {
                        return false;
                    }
                }
                if let Some(end) = params.end {
                    if m.created_at.unwrap_or(0) > end {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();

        items.sort_by_key(|m| -(m.created_at.unwrap_or(0)));

        Ok(items.into_iter().skip(offset).take(count).collect())
    }

    async fn search_memories(&self, _params: SearchMemoriesParams) -> Result<Vec<Memory>> {
        Ok(Vec::new())
    }

    async fn create_memory(&self, memory: &Memory, _table_name: &str) -> Result<UUID> {
        let mut stored = memory.clone();
        let id = stored.id.clone().unwrap_or_else(UUID::new_v4);
        stored.id = Some(id.clone());
        self.memories.write().await.insert(id.clone(), stored);
        Ok(id)
    }

    async fn update_memory(&self, memory: &Memory) -> Result<bool> {
        let id = match &memory.id {
            Some(id) => id.clone(),
            None => return Ok(false),
        };
        self.memories.write().await.insert(id, memory.clone());
        Ok(true)
    }

    async fn delete_memory(&self, memory_id: &UUID) -> Result<()> {
        self.memories.write().await.remove(memory_id);
        Ok(())
    }

    async fn get_memory_by_id(&self, id: &UUID) -> Result<Option<Memory>> {
        Ok(self.memories.read().await.get(id).cloned())
    }

    async fn create_world(&self, world: &World) -> Result<UUID> {
        self.worlds
            .write()
            .await
            .insert(world.id.clone(), world.clone());
        Ok(world.id.clone())
    }

    async fn get_world(&self, id: &UUID) -> Result<Option<World>> {
        Ok(self.worlds.read().await.get(id).cloned())
    }

    async fn create_room(&self, room: &Room) -> Result<UUID> {
        self.rooms.write().await.insert(room.id.clone(), room.clone());
        Ok(room.id.clone())
    }

    async fn get_room(&self, id: &UUID) -> Result<Option<Room>> {
        Ok(self.rooms.read().await.get(id).cloned())
    }

    async fn create_entity(&self, entity: &Entity) -> Result<bool> {
        let Some(id) = entity.id.clone() else {
            return Ok(false);
        };
        self.entities.write().await.insert(id, entity.clone());
        Ok(true)
    }

    async fn get_entity(&self, id: &UUID) -> Result<Option<Entity>> {
        Ok(self.entities.read().await.get(id).cloned())
    }

    async fn add_participant(&self, entity_id: &UUID, room_id: &UUID) -> Result<bool> {
        let mut parts = self.participants.write().await;
        let entry = parts.entry(room_id.clone()).or_default();
        if !entry.iter().any(|e| e == entity_id) {
            entry.push(entity_id.clone());
        }
        Ok(true)
    }

    async fn create_task(&self, task: &Task) -> Result<UUID> {
        let id = task.id.clone().unwrap_or_else(UUID::new_v4);
        self.tasks.write().await.insert(id.clone(), task.clone());
        Ok(id)
    }

    async fn get_task(&self, id: &UUID) -> Result<Option<Task>> {
        Ok(self.tasks.read().await.get(id).cloned())
    }

    async fn update_task(&self, id: &UUID, task: &Task) -> Result<()> {
        self.tasks.write().await.insert(id.clone(), task.clone());
        Ok(())
    }

    async fn delete_task(&self, id: &UUID) -> Result<()> {
        self.tasks.write().await.remove(id);
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

                let adapter: Arc<dyn DatabaseAdapter> = Arc::new(InMemoryAdapter::default());

                let plugins = if has_openai_key() {
                    vec![create_openai_elizaos_plugin()?]
                } else {
                    vec![]
                };

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
                                    Ok(eliza.generate_response(user_text))
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
                                    Ok(eliza.generate_response(user_text))
                                })
                            }),
                        )
                        .await;
                }

                info!("✅ elizaOS runtime initialized");
                Ok(Arc::new(runtime))
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

    let response_text = result
        .response_content
        .and_then(|c| c.text)
        .unwrap_or_else(|| "No response generated.".to_string());

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
    let callback: HandlerCallback = Arc::new(move |content: Content| {
        let tx = tx_cb.clone();
        async move {
            if let Some(text) = content.text {
                let _ = tx.send(StreamMsg::Text(text)).await;
            }
            Ok::<Vec<Memory>, anyhow::Error>(Vec::new())
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
// Main
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

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

