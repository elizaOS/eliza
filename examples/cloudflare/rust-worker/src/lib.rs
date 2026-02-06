//! elizaOS Cloudflare Worker (Rust)
//!
//! A serverless AI agent running on Cloudflare Workers using Rust/WASM.
//!
//! NOTE: Due to WASM limitations in Cloudflare Workers, the full elizaOS
//! runtime may have limited functionality. This example provides a REST API
//! that demonstrates the pattern but uses direct OpenAI API calls.
//!
//! For production Rust agents, consider:
//! - Running the full elizaOS Rust runtime on a proper server
//! - Using Cloudflare Durable Objects with the TypeScript runtime

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;
use worker::*;

// ============================================================================
// Configuration
// ============================================================================

const VERSION: &str = "2.0.0";

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(rename = "userId")]
    user_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    response: String,
    #[serde(rename = "userId")]
    user_id: String,
    character: String,
}

#[derive(Debug, Serialize)]
struct InfoResponse {
    name: String,
    bio: String,
    version: String,
    powered_by: String,
    runtime: String,
    note: String,
    endpoints: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: String,
    character: String,
    mode: String,
    note: String,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

#[derive(Debug, Clone)]
struct Character {
    name: String,
    bio: String,
    system: String,
}

// ============================================================================
// OpenAI API
// ============================================================================

#[derive(Debug, Deserialize)]
struct OpenAIChoice {
    message: OpenAIMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAIMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

fn get_character(env: &Env) -> Character {
    let name = env
        .var("CHARACTER_NAME")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "Eliza".to_string());

    let bio = env
        .var("CHARACTER_BIO")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "A helpful AI assistant powered by elizaOS.".to_string());

    let system = env
        .var("CHARACTER_SYSTEM")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| {
            format!(
                "You are {}, a helpful AI assistant. {}",
                name,
                bio
            )
        });

    Character { name, bio, system }
}

/// Call OpenAI API and return the response text.
///
/// NOTE: In a full elizaOS implementation, this would go through
/// runtime.message_service().handle_message() which handles the model
/// call, context building, and response generation automatically.
async fn call_openai(
    messages: &[ChatMessage],
    env: &Env,
) -> Result<String> {
    let api_key = env
        .secret("OPENAI_API_KEY")
        .map_err(|_| Error::RustError("OPENAI_API_KEY not configured".to_string()))?
        .to_string();

    let base_url = env
        .var("OPENAI_BASE_URL")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());

    let model = env
        .var("OPENAI_MODEL")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "gpt-4o-mini".to_string());

    let url = format!("{}/chat/completions", base_url);

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 1024
    });

    let mut headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {}", api_key))?;
    headers.set("Content-Type", "application/json")?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.to_string().into()));

    let request = Request::new_with_init(&url, &init)?;
    let mut response = Fetch::Request(request).send().await?;

    if response.status_code() != 200 {
        let error_text = response.text().await?;
        return Err(Error::RustError(format!(
            "OpenAI API error: {} - {}",
            response.status_code(),
            error_text
        )));
    }

    let response_json: OpenAIResponse = response.json().await?;
    
    response_json
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| Error::RustError("No response from OpenAI".to_string()))
}

// ============================================================================
// Response Helpers
// ============================================================================

fn json_response<T: Serialize>(data: &T, status: u16) -> Result<Response> {
    let json = serde_json::to_string(data)?;
    let mut headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("Access-Control-Allow-Origin", "*")?;

    Response::from_body(ResponseBody::Body(json.into_bytes()))
        .map(|r| r.with_headers(headers).with_status(status))
}

// ============================================================================
// Route Handlers
// ============================================================================

fn handle_info(env: &Env) -> Result<Response> {
    let character = get_character(env);

    let mut endpoints = HashMap::new();
    endpoints.insert(
        "POST /chat".to_string(),
        "Send a message and receive a response".to_string(),
    );
    endpoints.insert(
        "GET /health".to_string(),
        "Health check endpoint".to_string(),
    );
    endpoints.insert("GET /".to_string(), "This info endpoint".to_string());

    let info = InfoResponse {
        name: character.name,
        bio: character.bio,
        version: VERSION.to_string(),
        powered_by: "elizaOS".to_string(),
        runtime: "Rust (WASM)".to_string(),
        note: "Limited runtime - for full elizaOS features, use TypeScript worker or dedicated server".to_string(),
        endpoints,
    };

    json_response(&info, 200)
}

fn handle_health(env: &Env) -> Result<Response> {
    let character = get_character(env);

    let health = HealthResponse {
        status: "healthy".to_string(),
        character: character.name,
        mode: "simplified".to_string(),
        note: "WASM runtime - full elizaOS runtime may have limited functionality".to_string(),
    };

    json_response(&health, 200)
}

/// Handle POST /chat - process a chat message.
///
/// NOTE: This is a simplified implementation. The canonical elizaOS pattern would:
/// 1. Create an AgentRuntime with plugins
/// 2. Create a Memory with the message content
/// 3. Call runtime.message_service().handle_message()
///
/// Due to WASM limitations, we directly call the OpenAI API here.
async fn handle_chat(mut req: Request, env: Env) -> Result<Response> {
    let body: ChatRequest = req.json().await?;

    if body.message.trim().is_empty() {
        return json_response(
            &ErrorResponse {
                error: "Message is required".to_string(),
            },
            400,
        );
    }

    let character = get_character(&env);
    let user_id = body
        .user_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    // Build messages for OpenAI
    // In full elizaOS, this context would be built by providers
    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: character.system.clone(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: body.message,
        },
    ];

    let response_text = call_openai(&messages, &env).await?;

    let response = ChatResponse {
        response: response_text,
        user_id,
        character: character.name,
    };

    json_response(&response, 200)
}

fn handle_cors() -> Result<Response> {
    let mut headers = Headers::new();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type")?;

    Response::empty()
        .map(|r| r.with_headers(headers).with_status(204))
}

// ============================================================================
// Main Handler
// ============================================================================

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    let method = req.method();
    let path = req.path();

    // Handle CORS preflight
    if method == Method::Options {
        return handle_cors();
    }

    match (method, path.as_str()) {
        (Method::Get, "/") => handle_info(&env),
        (Method::Get, "/health") => handle_health(&env),
        (Method::Post, "/chat") => handle_chat(req, env).await,
        _ => json_response(
            &ErrorResponse {
                error: "Not found".to_string(),
            },
            404,
        ),
    }
}
