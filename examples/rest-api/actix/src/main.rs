//! elizaOS REST API Example - Actix Web
//!
//! A simple REST API server for chat with an AI agent.
//! Uses plugin-eliza-classic for responses.
//! No API keys or external services required.

use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

// ============================================================================
// Configuration
// ============================================================================

const CHARACTER_NAME: &str = "Eliza";
const CHARACTER_BIO: &str = "A classic pattern-matching psychotherapist simulation.";

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
    endpoints: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    character: String,
    timestamp: String,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

// ============================================================================
// App State
// ============================================================================

struct AppState {
    eliza: ElizaClassicPlugin,
}

// ============================================================================
// Handlers
// ============================================================================

/// GET / - Info endpoint
async fn info() -> impl Responder {
    let mut endpoints = std::collections::HashMap::new();
    endpoints.insert(
        "POST /chat".to_string(),
        "Send a message and receive a response".to_string(),
    );
    endpoints.insert("GET /health".to_string(), "Health check endpoint".to_string());
    endpoints.insert("GET /".to_string(), "This info endpoint".to_string());

    HttpResponse::Ok().json(InfoResponse {
        name: CHARACTER_NAME.to_string(),
        bio: CHARACTER_BIO.to_string(),
        version: "1.0.0".to_string(),
        powered_by: "elizaOS".to_string(),
        framework: "Actix Web".to_string(),
        endpoints,
    })
}

/// GET /health - Health check
async fn health() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "healthy".to_string(),
        character: CHARACTER_NAME.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

/// POST /chat - Chat with the agent
async fn chat(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ChatRequest>,
) -> impl Responder {
    if body.message.trim().is_empty() {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "Message is required".to_string(),
        });
    }

    let user_id = body
        .user_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let response = data.eliza.generate_response(&body.message);

    HttpResponse::Ok().json(ChatResponse {
        response,
        character: CHARACTER_NAME.to_string(),
        user_id,
    })
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

    let app_state = Arc::new(AppState {
        eliza: ElizaClassicPlugin::new(),
    });

    HttpServer::new(move || {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header();

        App::new()
            .wrap(cors)
            .app_data(web::Data::new(app_state.clone()))
            .route("/", web::get().to(info))
            .route("/health", web::get().to(health))
            .route("/chat", web::post().to(chat))
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}










