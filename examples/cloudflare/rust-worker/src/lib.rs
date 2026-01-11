//! elizaOS Cloudflare Worker (Rust)
//!
//! A serverless AI agent running on Cloudflare Workers using Rust/WASM.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use uuid::Uuid;
use worker::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(rename = "conversationId")]
    conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatResponse {
    response: String,
    #[serde(rename = "conversationId")]
    conversation_id: String,
    character: String,
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
struct HealthResponse {
    status: String,
    character: String,
    timestamp: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConversationState {
    messages: Vec<ChatMessage>,
    created_at: u64,
}

// Thread-safe conversation store
static CONVERSATIONS: RwLock<Option<HashMap<String, ConversationState>>> = RwLock::new(None);

fn get_conversations() -> HashMap<String, ConversationState> {
    let guard = CONVERSATIONS.read().unwrap();
    guard.clone().unwrap_or_default()
}

fn set_conversation(id: String, state: ConversationState) {
    let mut guard = CONVERSATIONS.write().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    if let Some(ref mut map) = *guard {
        map.insert(id, state);
    }
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
        .unwrap_or_else(|_| "gpt-5-mini".to_string());

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

fn json_response<T: Serialize>(data: &T, status: u16) -> Result<Response> {
    let json = serde_json::to_string(data)?;
    let mut headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("Access-Control-Allow-Origin", "*")?;

    Response::from_body(ResponseBody::Body(json.into_bytes()))
        .map(|r| r.with_headers(headers).with_status(status))
}

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
        version: "1.0.0".to_string(),
        powered_by: "elizaOS".to_string(),
        endpoints,
    };

    json_response(&info, 200)
}

fn handle_health(env: &Env) -> Result<Response> {
    let character = get_character(env);

    let health = HealthResponse {
        status: "healthy".to_string(),
        character: character.name,
        timestamp: Date::now().to_string(),
    };

    json_response(&health, 200)
}

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
    let conversation_id = body
        .conversation_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let mut conversations = get_conversations();
    let state = conversations
        .entry(conversation_id.clone())
        .or_insert_with(|| ConversationState {
            messages: vec![ChatMessage {
                role: "system".to_string(),
                content: character.system.clone(),
            }],
            created_at: Date::now().as_millis(),
        });

    // Add user message
    state.messages.push(ChatMessage {
        role: "user".to_string(),
        content: body.message,
    });

    // Call OpenAI
    let response_text = call_openai(&state.messages, &env).await?;

    // Add assistant response
    state.messages.push(ChatMessage {
        role: "assistant".to_string(),
        content: response_text.clone(),
    });

    // Save conversation
    set_conversation(conversation_id.clone(), state.clone());

    let response = ChatResponse {
        response: response_text,
        conversation_id,
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










