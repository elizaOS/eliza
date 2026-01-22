//! elizaOS REST API Example - Actix Web
//!
//! A REST API server for chat with an AI agent.
//! Uses the canonical elizaOS runtime with messageService.handleMessage pattern.

use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use elizaos::{
    AgentRuntime, Character, Content, Memory, UUID,
    runtime::RuntimeOptions,
    services::IMessageService,
};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

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

// Session UUIDs (generated at startup for consistency)
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

    // Initialize runtime
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

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

// ============================================================================
// Handlers
// ============================================================================

/// GET / - Info endpoint
async fn info() -> impl Responder {
    let mut endpoints = HashMap::new();
    endpoints.insert(
        "POST /chat".to_string(),
        "Send a message and receive a response".to_string(),
    );
    endpoints.insert("GET /health".to_string(), "Health check endpoint".to_string());
    endpoints.insert("GET /".to_string(), "This info endpoint".to_string());

    let mode = if RUNTIME.get().is_some() { "elizaos" } else { "initializing" };
    let error = INIT_ERROR.get().cloned();

    HttpResponse::Ok().json(InfoResponse {
        name: CHARACTER_NAME.to_string(),
        bio: CHARACTER_BIO.to_string(),
        version: "2.0.0".to_string(),
        powered_by: "elizaOS".to_string(),
        framework: "Actix Web".to_string(),
        mode: mode.to_string(),
        error,
        endpoints,
    })
}

/// GET /health - Health check
async fn health() -> impl Responder {
    let status = if RUNTIME.get().is_some() { "healthy" } else { "initializing" };
    let error = INIT_ERROR.get().cloned();

    HttpResponse::Ok().json(HealthResponse {
        status: status.to_string(),
        character: CHARACTER_NAME.to_string(),
        error,
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

/// POST /chat - Chat with the agent using the canonical runtime pattern
async fn chat(body: web::Json<ChatRequest>) -> impl Responder {
    if body.message.trim().is_empty() {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "Message is required".to_string(),
        });
    }

    let user_id = body
        .user_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Get runtime
    let runtime = match get_runtime().await {
        Ok(rt) => rt,
        Err(e) => {
            return HttpResponse::InternalServerError().json(ErrorResponse {
                error: e,
            });
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
            HttpResponse::Ok().json(ChatResponse {
                response,
                character: CHARACTER_NAME.to_string(),
                user_id,
            })
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(ErrorResponse {
                error: e.to_string(),
            })
        }
    }
}

// ============================================================================
// Main
// ============================================================================

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .unwrap_or(3000);

    println!("\n🌐 elizaOS REST API (Actix Web)");
    println!("   http://localhost:{}\n", port);
    println!("📚 Endpoints:");
    println!("   GET  /       - Agent info");
    println!("   GET  /health - Health check");
    println!("   POST /chat   - Chat with agent\n");

    // Pre-initialize the runtime
    if let Err(e) = get_runtime().await {
        println!("⚠️ Failed to initialize runtime on startup: {}", e);
    }

    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header();

        App::new()
            .wrap(cors)
            .route("/", web::get().to(info))
            .route("/health", web::get().to(health))
            .route("/chat", web::post().to(chat))
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
