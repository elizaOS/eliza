//! elizaOS A2A (Agent-to-Agent) Server - Rust
//!
//! An HTTP server that exposes an elizaOS agent for agent-to-agent communication.
//! Uses real elizaOS runtime with OpenAI plugin.

use anyhow::Result;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response, Sse},
    routing::{get, post},
    Json, Router,
};
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    types::{Content, Memory, UUID},
    IMessageService,
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
};
use tokio::sync::RwLock;
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
    runtime: RwLock<Option<AgentRuntime>>,
    sessions: RwLock<HashMap<String, Session>>,
    character_name: String,
    character_bio: String,
}

impl AppState {
    fn new() -> Self {
        Self {
            runtime: RwLock::new(None),
            sessions: RwLock::new(HashMap::new()),
            character_name: "Eliza".to_string(),
            character_bio: "A helpful AI assistant powered by elizaOS, available via A2A protocol."
                .to_string(),
        }
    }

    async fn get_runtime(&self) -> Result<AgentRuntime> {
        // Check if runtime is initialized
        {
            let guard = self.runtime.read().await;
            if guard.is_some() {
                // For simplicity, recreate runtime each time
                // In production, use Arc<AgentRuntime>
                drop(guard);
            }
        }

        info!("🚀 Initializing elizaOS runtime...");

        let character = parse_character(CHARACTER_JSON)?;

        let runtime = AgentRuntime::new(RuntimeOptions {
            character: Some(character),
            plugins: vec![create_openai_elizaos_plugin()?],
            ..Default::default()
        })
        .await?;

        runtime.initialize().await?;

        info!("✅ elizaOS runtime initialized");

        // Store in state
        {
            let mut guard = self.runtime.write().await;
            *guard = Some(runtime.clone());
        }

        Ok(runtime)
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

    let content = Content {
        text: Some(body.message),
        ..Default::default()
    };
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
    use futures::stream::{self, Stream};
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

    let session = state.get_or_create_session(&session_id).await;

    let content = Content {
        text: Some(body.message),
        ..Default::default()
    };
    let mut message = Memory::new(session.user_id, session.room_id, content);

    let result = match runtime
        .message_service()
        .handle_message(&runtime, &mut message, None, None)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let error_stream = stream::once(async move {
                Ok::<_, Infallible>(Event::default().data(
                    serde_json::json!({"error": e.to_string()}).to_string(),
                ))
            });
            return Sse::new(error_stream).keep_alive(KeepAlive::default()).into_response();
        }
    };

    let response_text = result
        .response_content
        .and_then(|c| c.text)
        .unwrap_or_else(|| "No response generated.".to_string());

    // Create SSE stream
    let events = vec![
        Event::default().data(serde_json::json!({"text": response_text}).to_string()),
        Event::default().data(serde_json::json!({"done": true}).to_string()),
    ];

    let stream = stream::iter(events.into_iter().map(Ok::<_, Infallible>));

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

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(agent_info))
        .route("/health", get(health_check))
        .route("/chat", post(chat))
        .route("/chat/stream", post(chat_stream))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

