//! GCP Cloud Run handler for elizaOS chat worker (Rust)
//!
//! This Cloud Run service processes chat messages and returns AI responses
//! using the elizaOS runtime with OpenAI as the LLM provider.

use anyhow::Result;
use axum::{
    extract::State,
    http::{Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    types::{Content, Memory, UUID},
    IMessageService,
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use futures::stream::{self, Stream};
use once_cell::sync::OnceCell;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, net::SocketAddr, pin::Pin, sync::Arc, time::SystemTime};
use tokio::sync::{Mutex, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};

// Global runtime instance (singleton)
static RUNTIME: OnceCell<Mutex<AgentRuntime>> = OnceCell::new();

// Shared state for conversations
type ConversationStore = Arc<RwLock<HashMap<String, ConversationState>>>;

#[derive(Clone)]
struct ConversationState {
    messages: Vec<ChatMessage>,
    created_at: SystemTime,
}

#[derive(Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
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

#[derive(Debug, Serialize)]
struct StreamEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "conversationId")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    character: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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

fn get_character_json() -> String {
    let (name, bio, system) = get_character();
    format!(
        r#"{{"name": "{}", "bio": "{}", "system": "{}"}}"#,
        name, bio, system
    )
}

/// Initialize or get the elizaOS runtime
async fn get_runtime() -> Result<&'static Mutex<AgentRuntime>> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }

    info!("Initializing elizaOS runtime...");

    let character = parse_character(&get_character_json())?;

    let runtime = AgentRuntime::new(RuntimeOptions {
        character: Some(character),
        plugins: vec![create_openai_elizaos_plugin()?],
        ..Default::default()
    })
    .await?;

    runtime.initialize().await?;

    info!("elizaOS runtime initialized successfully");

    // Store in global (ignore if another thread beat us)
    let _ = RUNTIME.set(Mutex::new(runtime));
    Ok(RUNTIME.get().expect("runtime was just set"))
}

/// Health check handler
async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        runtime: "rust".to_string(),
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
    endpoints.insert(
        "POST /chat/stream".to_string(),
        "Send a message and receive a streaming response".to_string(),
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

/// Chat handler
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
            error!("Chat error: {}", e);
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
    let runtime_mutex = get_runtime().await?;
    let runtime = runtime_mutex.lock().await;

    // Generate IDs
    let user_id = UUID::new_v4();
    let room_id = UUID::new_v4();
    let conversation_id = request
        .conversation_id
        .unwrap_or_else(|| format!("conv-{}", uuid::Uuid::new_v4()));

    // Create message
    let content = Content {
        text: Some(request.message),
        source: Some("gcp-cloud-run".to_string()),
        ..Default::default()
    };
    let mut message = Memory::new(user_id.clone(), room_id.clone(), content);

    // Process message
    let result = runtime
        .message_service()
        .handle_message(&runtime, &mut message, None, None)
        .await?;

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

/// Streaming chat handler
async fn handle_stream_chat(
    State(conversations): State<ConversationStore>,
    Json(request): Json<ChatRequest>,
) -> Response {
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

    let (name, _, system) = get_character();
    let conversation_id = request
        .conversation_id
        .clone()
        .unwrap_or_else(|| format!("conv-{}", uuid::Uuid::new_v4()));

    // Get or create conversation state
    let messages = {
        let mut convos = conversations.write().await;
        let state = convos
            .entry(conversation_id.clone())
            .or_insert_with(|| ConversationState {
                messages: vec![ChatMessage {
                    role: "system".to_string(),
                    content: system,
                }],
                created_at: SystemTime::now(),
            });
        state.messages.push(ChatMessage {
            role: "user".to_string(),
            content: request.message.clone(),
        });
        state.messages.clone()
    };

    let stream = create_stream(name.clone(), conversation_id.clone(), messages, conversations);

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn create_stream(
    character_name: String,
    conversation_id: String,
    messages: Vec<ChatMessage>,
    conversations: ConversationStore,
) -> Pin<Box<dyn Stream<Item = Result<Event, std::convert::Infallible>> + Send>> {
    Box::pin(stream::once(async move {
        // Send metadata first
        let metadata = StreamEvent {
            text: None,
            conversation_id: Some(conversation_id.clone()),
            character: Some(character_name),
            error: None,
        };

        let events = process_stream(conversation_id, messages, conversations).await;
        stream::iter(
            std::iter::once(Ok(Event::default().data(
                serde_json::to_string(&metadata).unwrap_or_default(),
            )))
            .chain(events.into_iter().map(|e| {
                Ok(Event::default().data(serde_json::to_string(&e).unwrap_or_default()))
            }))
            .chain(std::iter::once(Ok(Event::default().data("[DONE]")))),
        )
    })
    .flatten())
}

async fn process_stream(
    conversation_id: String,
    messages: Vec<ChatMessage>,
    conversations: ConversationStore,
) -> Vec<StreamEvent> {
    let base_url = env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
    let model = env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-5-mini".to_string());
    let api_key = match env::var("OPENAI_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            return vec![StreamEvent {
                text: None,
                conversation_id: None,
                character: None,
                error: Some("OPENAI_API_KEY not set".to_string()),
            }];
        }
    };

    let client = Client::new();

    let openai_messages: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content
            })
        })
        .collect();

    let response = match client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": model,
            "messages": openai_messages,
            "temperature": 0.7,
            "max_tokens": 1024,
            "stream": true
        }))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            return vec![StreamEvent {
                text: None,
                conversation_id: None,
                character: None,
                error: Some(format!("Request error: {}", e)),
            }];
        }
    };

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return vec![StreamEvent {
            text: None,
            conversation_id: None,
            character: None,
            error: Some(format!("OpenAI error: {}", error_text)),
        }];
    }

    let mut events = Vec::new();
    let mut full_response = String::new();

    let body = match response.text().await {
        Ok(body) => body,
        Err(e) => {
            return vec![StreamEvent {
                text: None,
                conversation_id: None,
                character: None,
                error: Some(format!("Read error: {}", e)),
            }];
        }
    };

    for line in body.lines() {
        if line.starts_with("data: ") {
            let data = &line[6..];
            if data == "[DONE]" {
                continue;
            }

            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(content) = parsed["choices"][0]["delta"]["content"].as_str() {
                    full_response.push_str(content);
                    events.push(StreamEvent {
                        text: Some(content.to_string()),
                        conversation_id: None,
                        character: None,
                        error: None,
                    });
                }
            }
        }
    }

    // Store the assistant response
    if !full_response.is_empty() {
        let mut convos = conversations.write().await;
        if let Some(state) = convos.get_mut(&conversation_id) {
            state.messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: full_response,
            });
        }

        // Prune old conversations
        if convos.len() > 100 {
            let mut sorted: Vec<_> = convos.iter().collect();
            sorted.sort_by(|a, b| a.1.created_at.cmp(&b.1.created_at));
            for (key, _) in sorted.iter().take(sorted.len().saturating_sub(100)) {
                convos.remove(*key);
            }
        }
    }

    events
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

    // Shared conversation store
    let conversations: ConversationStore = Arc::new(RwLock::new(HashMap::new()));

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
        .route("/chat/stream", post(handle_stream_chat))
        .layer(cors)
        .with_state(conversations);

    let port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "8080".to_string())
        .parse()
        .unwrap_or(8080);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    info!("🚀 elizaOS Cloud Run worker started on port {}", port);
    info!("📍 Health check: http://localhost:{}/health", port);
    info!("💬 Chat endpoint: http://localhost:{}/chat", port);
    info!("📡 Stream endpoint: http://localhost:{}/chat/stream", port);

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

