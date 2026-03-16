//! AWS Lambda handler library for elizaOS chat worker (Rust)
//!
//! This Lambda function processes chat messages and returns AI responses
//! using the full elizaOS runtime with OpenAI as the LLM provider.

use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    services::IMessageService,
    types::{Content, Memory, UUID},
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use lambda_http::{
    http::{Method, StatusCode},
    Body, Request, Response,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tracing::{error, info};

// Async singleton runtime instance
static RUNTIME: OnceCell<Arc<AgentRuntime>> = OnceCell::const_new();

async fn get_runtime() -> Result<Arc<AgentRuntime>, String> {
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

            let character = parse_character(&character_json)
                .map_err(|e| format!("Failed to parse character: {}", e))?;

            let openai_plugin = create_openai_elizaos_plugin()
                .map_err(|e| format!("Failed to create OpenAI plugin: {}", e))?;

            let runtime = AgentRuntime::new(RuntimeOptions {
                character: Some(character),
                plugins: vec![openai_plugin],
                ..Default::default()
            })
            .await
            .map_err(|e| format!("Failed to create runtime: {}", e))?;

            runtime
                .initialize()
                .await
                .map_err(|e| format!("Failed to initialize runtime: {}", e))?;

            info!("elizaOS runtime initialized successfully");
            Ok(Arc::new(runtime))
        })
        .await
        .map(|r| r.clone())
}

// Request/Response types
#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    #[serde(rename = "userId")]
    pub user_id: Option<String>,
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub response: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub runtime: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
}

/// Create a JSON response
pub fn json_response<T: Serialize>(status: StatusCode, body: &T) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "Content-Type")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .body(Body::from(serde_json::to_string(body).unwrap_or_default()))
        .unwrap()
}

/// Handle chat message using elizaOS runtime
pub async fn handle_chat(request: ChatRequest) -> Result<ChatResponse, String> {
    let runtime = get_runtime().await?;

    // Generate IDs for this conversation
    let user_id = UUID::new_v4();
    let conversation_id = request
        .conversation_id
        .unwrap_or_else(|| format!("conv-{}", &uuid::Uuid::new_v4().to_string()[..12]));
    let room_id = UUID::new_v4(); // In a real app, derive from conversation_id

    // Create message memory
    let content = Content {
        text: Some(request.message),
        ..Default::default()
    };
    let mut message = Memory::new(user_id, room_id, content);

    // Process message through elizaOS runtime
    let result = runtime
        .message_service()
        .handle_message(&runtime, &mut message, None, None)
        .await
        .map_err(|e| format!("Message handling error: {}", e))?;

    // Extract response text
    let response_text = result
        .response_content
        .and_then(|c| c.text)
        .unwrap_or_else(|| "I apologize, but I could not generate a response.".to_string());

    Ok(ChatResponse {
        response: response_text,
        conversation_id,
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

/// Main Lambda handler
pub async fn function_handler(event: Request) -> Result<Response<Body>, lambda_http::Error> {
    let method = event.method();
    let path = event.uri().path();

    info!("{} {}", method, path);

    // Handle CORS preflight
    if method == Method::OPTIONS {
        return Ok(json_response(
            StatusCode::OK,
            &serde_json::json!({"message": "OK"}),
        ));
    }

    // Health check
    if (path == "/" || path == "/health") && method == Method::GET {
        let response = HealthResponse {
            status: "healthy".to_string(),
            runtime: "elizaos-rust".to_string(),
            version: "1.0.0".to_string(),
        };
        return Ok(json_response(StatusCode::OK, &response));
    }

    // Chat endpoint
    if path == "/chat" {
        if method != Method::POST {
            let error = ErrorResponse {
                error: "Method not allowed".to_string(),
                code: "METHOD_NOT_ALLOWED".to_string(),
            };
            return Ok(json_response(StatusCode::METHOD_NOT_ALLOWED, &error));
        }

        // Parse request body
        let body = match event.body() {
            Body::Text(text) => text.clone(),
            Body::Binary(bytes) => String::from_utf8_lossy(bytes).to_string(),
            Body::Empty => {
                let error = ErrorResponse {
                    error: "Request body is required".to_string(),
                    code: "BAD_REQUEST".to_string(),
                };
                return Ok(json_response(StatusCode::BAD_REQUEST, &error));
            }
        };

        let request: ChatRequest = match serde_json::from_str(&body) {
            Ok(req) => req,
            Err(e) => {
                error!("Failed to parse request: {}", e);
                let error = ErrorResponse {
                    error: format!("Invalid JSON: {}", e),
                    code: "BAD_REQUEST".to_string(),
                };
                return Ok(json_response(StatusCode::BAD_REQUEST, &error));
            }
        };

        if request.message.trim().is_empty() {
            let error = ErrorResponse {
                error: "Message is required and must be a non-empty string".to_string(),
                code: "BAD_REQUEST".to_string(),
            };
            return Ok(json_response(StatusCode::BAD_REQUEST, &error));
        }

        match handle_chat(request).await {
            Ok(response) => {
                return Ok(json_response(StatusCode::OK, &response));
            }
            Err(e) => {
                error!("Chat error: {}", e);
                let error = ErrorResponse {
                    error: "Internal server error".to_string(),
                    code: "INTERNAL_ERROR".to_string(),
                };
                return Ok(json_response(StatusCode::INTERNAL_SERVER_ERROR, &error));
            }
        }
    }

    // Not found
    let error = ErrorResponse {
        error: "Not found".to_string(),
        code: "NOT_FOUND".to_string(),
    };
    Ok(json_response(StatusCode::NOT_FOUND, &error))
}
