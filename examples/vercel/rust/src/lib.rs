//! Vercel Edge Function handler library for elizaOS chat worker (Rust)
//!
//! This Edge Function processes chat messages and returns AI responses
//! using the full elizaOS runtime with OpenAI as the LLM provider.
//!
//! Compiled to WebAssembly for Vercel Edge Runtime.

use elizaos::{
    parse_character,
    runtime::{AgentRuntime, RuntimeOptions},
    services::IMessageService,
    types::{Content, Memory, UUID},
};
use elizaos_plugin_openai::create_openai_elizaos_plugin;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use web_sys::{Request, Response, ResponseInit, Headers};
use js_sys::Promise;

// Static runtime for reuse across invocations
static mut RUNTIME: Option<Arc<AgentRuntime>> = None;

async fn get_runtime() -> Result<Arc<AgentRuntime>, String> {
    unsafe {
        if let Some(ref runtime) = RUNTIME {
            return Ok(runtime.clone());
        }

        web_sys::console::log_1(&"Initializing elizaOS runtime...".into());

        let character_json = r#"{
            "name": "Eliza",
            "bio": "A helpful AI assistant.",
            "system": "You are a helpful, concise AI assistant. Respond thoughtfully to user messages."
        }"#;

        let character = parse_character(character_json)
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

        web_sys::console::log_1(&"elizaOS runtime initialized successfully".into());

        RUNTIME = Some(runtime.clone());
        Ok(runtime)
    }
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
fn json_response(status: u16, body: &str) -> Result<Response, JsValue> {
    let headers = Headers::new()?;
    headers.set("Content-Type", "application/json")?;
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type")?;
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;

    let init = ResponseInit::new();
    init.set_status(status);
    init.set_headers(&headers);

    Response::new_with_opt_str_and_init(Some(body), &init)
}

/// Handle chat message using elizaOS runtime
async fn handle_chat(request: ChatRequest) -> Result<ChatResponse, String> {
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
        timestamp: js_sys::Date::new_0().to_iso_string().into(),
    })
}

/// Main Vercel Edge Function handler (exported to JavaScript)
#[wasm_bindgen]
pub fn handler(request: Request) -> Promise {
    future_to_promise(async move {
        match handle_request(request).await {
            Ok(response) => Ok(response.into()),
            Err(_e) => {
                let error_response = ErrorResponse {
                    error: "Internal server error".to_string(),
                    code: "INTERNAL_ERROR".to_string(),
                };
                let body = serde_json::to_string(&error_response).unwrap_or_default();
                json_response(500, &body).map(|r| r.into())
            }
        }
    })
}

async fn handle_request(request: Request) -> Result<Response, JsValue> {
    let method = request.method();
    let url = web_sys::Url::new(&request.url())?;
    let path = url.pathname();

    web_sys::console::log_1(&format!("{} {}", method, path).into());

    // Handle CORS preflight
    if method == "OPTIONS" {
        let body = serde_json::json!({"message": "OK"}).to_string();
        return json_response(200, &body);
    }

    // Health check
    if (path == "/api" || path == "/api/health" || path == "/") && method == "GET" {
        let response = HealthResponse {
            status: "healthy".to_string(),
            runtime: "elizaos-rust".to_string(),
            version: "1.0.0".to_string(),
        };
        let body = serde_json::to_string(&response).map_err(|e| JsValue::from_str(&e.to_string()))?;
        return json_response(200, &body);
    }

    // Chat endpoint
    if path == "/api/chat" {
        if method != "POST" {
            let error = ErrorResponse {
                error: "Method not allowed".to_string(),
                code: "METHOD_NOT_ALLOWED".to_string(),
            };
            let body = serde_json::to_string(&error).map_err(|e| JsValue::from_str(&e.to_string()))?;
            return json_response(405, &body);
        }

        // Parse request body
        let body_promise = request.text()?;
        let body_js = wasm_bindgen_futures::JsFuture::from(body_promise).await?;
        let body_str = body_js.as_string().unwrap_or_default();

        if body_str.is_empty() {
            let error = ErrorResponse {
                error: "Request body is required".to_string(),
                code: "BAD_REQUEST".to_string(),
            };
            let body = serde_json::to_string(&error).map_err(|e| JsValue::from_str(&e.to_string()))?;
            return json_response(400, &body);
        }

        let chat_request: ChatRequest = match serde_json::from_str(&body_str) {
            Ok(req) => req,
            Err(e) => {
                web_sys::console::error_1(&format!("Failed to parse request: {}", e).into());
                let error = ErrorResponse {
                    error: format!("Invalid JSON: {}", e),
                    code: "BAD_REQUEST".to_string(),
                };
                let body = serde_json::to_string(&error).map_err(|e| JsValue::from_str(&e.to_string()))?;
                return json_response(400, &body);
            }
        };

        if chat_request.message.trim().is_empty() {
            let error = ErrorResponse {
                error: "Message is required and must be a non-empty string".to_string(),
                code: "BAD_REQUEST".to_string(),
            };
            let body = serde_json::to_string(&error).map_err(|e| JsValue::from_str(&e.to_string()))?;
            return json_response(400, &body);
        }

        match handle_chat(chat_request).await {
            Ok(response) => {
                let body = serde_json::to_string(&response).map_err(|e| JsValue::from_str(&e.to_string()))?;
                return json_response(200, &body);
            }
            Err(e) => {
                web_sys::console::error_1(&format!("Chat error: {}", e).into());
                let error = ErrorResponse {
                    error: "Internal server error".to_string(),
                    code: "INTERNAL_ERROR".to_string(),
                };
                let body = serde_json::to_string(&error).map_err(|e| JsValue::from_str(&e.to_string()))?;
                return json_response(500, &body);
            }
        }
    }

    // Not found
    let error = ErrorResponse {
        error: "Not found".to_string(),
        code: "NOT_FOUND".to_string(),
    };
    let body = serde_json::to_string(&error).map_err(|e| JsValue::from_str(&e.to_string()))?;
    json_response(404, &body)
}

