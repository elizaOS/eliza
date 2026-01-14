//! GCP Cloud Run handler for elizaOS chat worker (Rust)
//!
//! This Cloud Run service processes chat messages and returns AI responses
//! using the elizaOS runtime with OpenAI as the LLM provider.

use anyhow::Result;
use axum::{
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    types::{Content, Memory, UUID},
};
use elizaos::services::IMessageService;
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, net::SocketAddr, sync::Arc};
use tokio::sync::OnceCell;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};

// Async singleton runtime instance
static RUNTIME: OnceCell<Arc<AgentRuntime>> = OnceCell::const_new();

async fn get_runtime() -> Result<Arc<AgentRuntime>> {
    RUNTIME
        .get_or_try_init(|| async {
            info!("Initializing elizaOS runtime...");

            let character_json = format!(
                r#"{{"name": "{}", "bio": "{}", "system": "{}"}}"#,
                env::var("CHARACTER_NAME").unwrap_or_else(|_| "Eliza".to_string()),
                env::var("CHARACTER_BIO").unwrap_or_else(|_| "A helpful AI assistant.".to_string()),
                env::var("CHARACTER_SYSTEM").unwrap_or_else(|_| {
                    "You are a helpful, concise AI assistant. Respond thoughtfully to user messages."
                        .to_string()
                })
            );

            let character = parse_character(&character_json)?;

            let openai_plugin = create_openai_elizaos_plugin()?;

            let runtime = AgentRuntime::new(RuntimeOptions {
                character: Some(character),
                plugins: vec![openai_plugin],
                ..Default::default()
            })
            .await
            ?;

            runtime
                .initialize()
                .await
                ?;

            info!("elizaOS runtime initialized successfully");
            Ok(Arc::new(runtime))
        })
        .await
        .cloned()
}

/// Get character configuration from environment variables
fn get_character() -> (String, String, String) {
    let name = env::var("CHARACTER_NAME").unwrap_or_else(|_| "Eliza".to_string());
    let bio = env::var("CHARACTER_BIO").unwrap_or_else(|_| "A helpful AI assistant.".to_string());
    let system = env::var("CHARACTER_SYSTEM").unwrap_or_else(|_| {
        "You are a helpful, concise AI assistant. Respond thoughtfully to user messages."
            .to_string()
    });

    (name, bio, system)
}

// Request/Response types
#[derive(Debug, Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(rename = "userId")]
    user_id: Option<String>,
    #[serde(rename = "conversationId")]
    conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    response: String,
    #[serde(rename = "conversationId")]
    conversation_id: String,
    timestamp: String,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    runtime: String,
    version: String,
}

#[derive(Debug, Serialize)]
struct InfoResponse {
    name: String,
    bio: String,
    version: String,
    powered_by: String,
    endpoints: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
    code: String,
}

/// Health check handler
async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        runtime: "elizaos-rust".to_string(),
        version: "1.0.0".to_string(),
    })
}

/// Info handler
async fn handle_info() -> Json<InfoResponse> {
    let (name, bio, _) = get_character();

    let mut endpoints = HashMap::new();
    endpoints.insert(
        "POST /chat".to_string(),
        "Send a message and receive a response".to_string(),
    );
    endpoints.insert("GET /health".to_string(), "Health check endpoint".to_string());
    endpoints.insert("GET /".to_string(), "This info endpoint".to_string());

    Json(InfoResponse {
        name,
        bio,
        version: "1.0.0".to_string(),
        powered_by: "elizaOS".to_string(),
        endpoints,
    })
}

/// Chat handler using elizaOS runtime
async fn handle_chat(Json(request): Json<ChatRequest>) -> Response {
    if request.message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Message is required and must be a non-empty string".to_string(),
                code: "BAD_REQUEST".to_string(),
            }),
        )
            .into_response();
    }

    match process_chat(request).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => {
            error!("Chat error: {:#}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Internal server error".to_string(),
                    code: "INTERNAL_ERROR".to_string(),
                }),
            )
                .into_response()
        }
    }
}

async fn process_chat(request: ChatRequest) -> Result<ChatResponse> {
    let runtime = get_runtime().await?;

    // Generate IDs for this conversation
    let user_id = request
        .user_id
        .as_deref()
        .and_then(|s| UUID::new(s).ok())
        .unwrap_or_else(UUID::new_v4);
    let conversation_id = request
        .conversation_id
        .unwrap_or_else(|| format!("conv-{}", &uuid::Uuid::new_v4().to_string()[..12]));
    let room_id = UUID::new_v4();

    // Create message memory
    let content = Content {
        text: Some(request.message),
        source: Some("gcp-cloud-run".to_string()),
        ..Default::default()
    };
    let mut message = Memory::new(user_id, room_id, content);

    // Process message through elizaOS runtime
    let result = runtime
        .message_service()
        .handle_message(&runtime, &mut message, None, None)
        .await
        ?;

    // Extract response text
    let response_text = result
        .response_content
        .and_then(|c| c.text)
        .unwrap_or_else(|| "I apologize, but I could not generate a response.".to_string());

    Ok(ChatResponse {
        response: response_text,
        conversation_id,
        timestamp: Utc::now().to_rfc3339(),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env file if present
    let _ = dotenvy::dotenv();

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    // CORS configuration
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    // Build router
    let app = Router::new()
        .route("/", get(handle_info))
        .route("/health", get(handle_health))
        .route("/chat", post(handle_chat))
        .layer(cors);

    let port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "8080".to_string())
        .parse()
        .unwrap_or(8080);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    info!("🚀 elizaOS Cloud Run worker started on port {}", port);
    info!("📍 Health check: http://localhost:{}/health", port);
    info!("💬 Chat endpoint: http://localhost:{}/chat", port);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install CTRL+C handler");
    info!("Received shutdown signal");
}
