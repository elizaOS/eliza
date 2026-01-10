//! elizaOS REST API Example - Rocket
//!
//! A simple REST API server for chat with an AI agent.
//! Uses plugin-eliza-classic for responses.
//! No API keys or external services required.

#[macro_use]
extern crate rocket;

use elizaos_plugin_eliza_classic::ElizaClassicPlugin;
use rocket::fairing::{Fairing, Info, Kind};
use rocket::http::Header;
use rocket::serde::json::Json;
use rocket::{Request, Response, State};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    endpoints: HashMap<String, String>,
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
// CORS Fairing
// ============================================================================

pub struct Cors;

#[rocket::async_trait]
impl Fairing for Cors {
    fn info(&self) -> Info {
        Info {
            name: "CORS",
            kind: Kind::Response,
        }
    }

    async fn on_response<'r>(&self, _request: &'r Request<'_>, response: &mut Response<'r>) {
        response.set_header(Header::new("Access-Control-Allow-Origin", "*"));
        response.set_header(Header::new(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS",
        ));
        response.set_header(Header::new("Access-Control-Allow-Headers", "Content-Type"));
    }
}

// ============================================================================
// Routes
// ============================================================================

/// GET / - Info endpoint
#[get("/")]
fn info() -> Json<InfoResponse> {
    let mut endpoints = HashMap::new();
    endpoints.insert(
        "POST /chat".to_string(),
        "Send a message and receive a response".to_string(),
    );
    endpoints.insert("GET /health".to_string(), "Health check endpoint".to_string());
    endpoints.insert("GET /".to_string(), "This info endpoint".to_string());

    Json(InfoResponse {
        name: CHARACTER_NAME.to_string(),
        bio: CHARACTER_BIO.to_string(),
        version: "1.0.0".to_string(),
        powered_by: "elizaOS".to_string(),
        framework: "Rocket".to_string(),
        endpoints,
    })
}

/// GET /health - Health check
#[get("/health")]
fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        character: CHARACTER_NAME.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

/// POST /chat - Chat with the agent
#[post("/chat", format = "json", data = "<body>")]
fn chat(state: &State<Arc<AppState>>, body: Json<ChatRequest>) -> Result<Json<ChatResponse>, Json<ErrorResponse>> {
    if body.message.trim().is_empty() {
        return Err(Json(ErrorResponse {
            error: "Message is required".to_string(),
        }));
    }

    let user_id = body
        .user_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let response = state.eliza.generate_response(&body.message);

    Ok(Json(ChatResponse {
        response,
        character: CHARACTER_NAME.to_string(),
        user_id,
    }))
}

/// OPTIONS handler for CORS preflight
#[options("/<_..>")]
fn options() -> &'static str {
    ""
}

// ============================================================================
// Main
// ============================================================================

#[launch]
fn rocket() -> _ {
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse()
        .unwrap_or(3000);

    println!("\n🌐 elizaOS REST API (Rocket)");
    println!("   http://localhost:{}\n", port);
    println!("📚 Endpoints:");
    println!("   GET  /       - Agent info");
    println!("   GET  /health - Health check");
    println!("   POST /chat   - Chat with agent\n");

    let state = Arc::new(AppState {
        eliza: ElizaClassicPlugin::new(),
    });

    let figment = rocket::Config::figment()
        .merge(("port", port))
        .merge(("address", "0.0.0.0"));

    rocket::custom(figment)
        .attach(Cors)
        .manage(state)
        .mount("/", routes![info, health, chat, options])
}




