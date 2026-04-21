//! elizaOS REST API Example - Axum
//!
//! A REST API server for chat with an AI agent.
//! Uses the canonical elizaOS runtime with messageService.handleMessage pattern.

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use elizaos::{
    AgentRuntime, Character, Content, Memory, UUID,
    runtime::RuntimeOptions,
    services::IMessageService,
};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

// ============================================================================
// Configuration
// ============================================================================

const CHARACTER_NAME: &str = "Eliza";
const CHARACTER_BIO: &str = "A helpful AI assistant powered by elizaOS.";

// ============================================================================
// Runtime State
// ============================================================================

static RUNTIME: OnceCell<Arc<AgentRuntime>> = OnceCell::new();
static INIT_ERROR: OnceCell<String> = OnceCell::new();
static ROOM_ID: OnceCell<UUID> = OnceCell::new();
static WORLD_ID: OnceCell<UUID> = OnceCell::new();

fn get_room_id() -> UUID {
    ROOM_ID.get_or_init(|| UUID::from_string("rest-api-room")).clone()
}

fn get_world_id() -> UUID {
    WORLD_ID.get_or_init(|| UUID::from_string("rest-api-world")).clone()
}

async fn get_runtime() -> Result<Arc<AgentRuntime>, String> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime.clone());
    }

    if let Some(error) = INIT_ERROR.get() {
        return Err(error.clone());
    }

    println!("🚀 Initializing elizaOS runtime...");

    let character_name = std::env::var("CHARACTER_NAME").unwrap_or_else(|_| CHARACTER_NAME.to_string());
    let character_bio = std::env::var("CHARACTER_BIO").unwrap_or_else(|_| CHARACTER_BIO.to_string());

    let character = Character {
        name: character_name,
        bio: elizaos::Bio::Single(character_bio),
        ..Default::default()
    };

    match AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        ..Default::default()
    }).await {
        Ok(runtime) => {
            if let Err(e) = runtime.initialize().await {
                let error = format!("Failed to initialize runtime: {}", e);
                INIT_ERROR.set(error.clone()).ok();
                return Err(error);
            }

            println!("✅ elizaOS runtime initialized");
            RUNTIME.set(runtime.clone()).ok();
            Ok(runtime)
        }
        Err(e) => {
            let error = format!("Failed to create runtime: {}", e);
            INIT_ERROR.set(error.clone()).ok();
            Err(error)
        }
    }
}

// ============================================================================
// Request/Response Types
// ============================================================================

#[derive(Debug, Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(rename = "userId")]
    user_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    response: String,
    character: String,
    #[serde(rename = "userId")]
    user_id: String,
}

#[derive(Debug, Serialize)]
struct InfoResponse {
    name: String,
    bio: String,
    version: String,
    powered_by: String,
    framework: String,
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    endpoints: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    character: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    timestamp: String,
}

// ============================================================================
// App State
// ============================================================================

#[derive(Clone)]
struct AppState {}

// ============================================================================
// Handlers
// ============================================================================

/// GET / - Info endpoint
async fn info() -> Json<InfoResponse> {
    let mut endpoints = HashMap::new();
    endpoints.insert(
        "POST /chat".to_string(),
        "Send a message and receive a response".to_string(),
    );
    endpoints.insert("GET /health".to_string(), "Health check endpoint".to_string());
    endpoints.insert("GET /".to_string(), "This info endpoint".to_string());

    let mode = if RUNTIME.get().is_some() { "elizaos" } else { "initializing" };
    let error = INIT_ERROR.get().cloned();

    Json(InfoResponse {
        name: CHARACTER_NAME.to_string(),
        bio: CHARACTER_BIO.to_string(),
        version: "2.0.0".to_string(),
        powered_by: "elizaOS".to_string(),
        framework: "Axum".to_string(),
        mode: mode.to_string(),
        error,
        endpoints,
    })
}

/// GET /health - Health check
async fn health() -> Json<HealthResponse> {
    let status = if RUNTIME.get().is_some() { "healthy" } else { "initializing" };
    let error = INIT_ERROR.get().cloned();

    Json(HealthResponse {
        status: status.to_string(),
        character: CHARACTER_NAME.to_string(),
        error,
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

/// POST /chat - Chat with the agent using the canonical runtime pattern
async fn chat(
    State(_state): State<AppState>,
    Json(body): Json<ChatRequest>,
) -> impl IntoResponse {
    if body.message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Message is required" })),
        )
            .into_response();
    }

    let user_id = body.user_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Get runtime
    let runtime = match get_runtime().await {
        Ok(rt) => rt,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e })),
            )
                .into_response();
        }
    };

    // Create message memory
    let entity_id = UUID::from_string(&user_id);
    let room_id = get_room_id();

    let mut message = Memory {
        id: Some(UUID::new_v4()),
        entity_id,
        agent_id: Some(runtime.agent_id.clone()),
        room_id,
        world_id: Some(get_world_id()),
        content: Content {
            text: Some(body.message.clone()),
            source: Some("rest_api".to_string()),
            ..Default::default()
        },
        ..Default::default()
    };

    // Process message through the runtime's message service
    let message_service = runtime.message_service();
    let response_text = Arc::new(RwLock::new(String::new()));
    let response_text_clone = response_text.clone();

    let callback = move |content: Content| {
        let response_text = response_text_clone.clone();
        async move {
            if let Some(text) = content.text {
                let mut guard = response_text.write().await;
                guard.push_str(&text);
            }
            Ok(vec![])
        }
    };

    match message_service.handle_message(&runtime, &mut message, Some(Box::new(callback)), None).await {
        Ok(_result) => {
            let response = response_text.read().await.clone();
            (
                StatusCode::OK,
                Json(ChatResponse {
                    response,
                    character: CHARACTER_NAME.to_string(),
                    user_id,
                }),
            )
                .into_response()
        }
        Err(e) => {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .unwrap_or(3000);

    println!("\n🌐 elizaOS REST API (Axum)");
    println!("   http://localhost:{}\n", port);
    println!("📚 Endpoints:");
    println!("   GET  /       - Agent info");
    println!("   GET  /health - Health check");
    println!("   POST /chat   - Chat with agent\n");

    // Pre-initialize the runtime
    if let Err(e) = get_runtime().await {
        println!("⚠️ Failed to initialize runtime on startup: {}", e);
    }

    let state = AppState {};

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(info))
        .route("/health", get(health))
        .route("/chat", post(chat))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
