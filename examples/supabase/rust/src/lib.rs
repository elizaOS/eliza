//! elizaOS chat handler compiled to WebAssembly for Supabase Edge Functions
//!
//! This module provides a WASM-compatible chat handler that can be called from
//! Deno/TypeScript edge functions. It handles message processing and response
//! generation logic that can be offloaded to Rust for performance.
//!
//! Build with: wasm-pack build --target web --out-dir ../functions/eliza-chat-wasm/wasm

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// ============================================================================
// Type Definitions (matching TypeScript types)
// ============================================================================

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

#[derive(Debug, Serialize, Deserialize)]
pub struct Character {
    pub name: String,
    pub bio: String,
    pub system: String,
}

#[derive(Debug, Serialize)]
pub struct OpenAIMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct OpenAIRequest {
    pub model: String,
    pub messages: Vec<OpenAIMessage>,
    pub max_tokens: u32,
    pub temperature: f32,
}

// ============================================================================
// WASM Exports
// ============================================================================

/// Initialize the WASM module (called once on load)
#[wasm_bindgen(start)]
pub fn init() {
    // Set panic hook for better error messages
    console_error_panic_hook::set_once();
    log("elizaOS WASM module initialized");
}

/// Console logging helper
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

    #[wasm_bindgen(js_namespace = console)]
    fn error(s: &str);
}

/// Set panic hook for better error messages in browser console
mod console_error_panic_hook {
    use std::sync::Once;
    static SET_HOOK: Once = Once::new();

    pub fn set_once() {
        SET_HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|panic_info| {
                let msg = format!("WASM panic: {}", panic_info);
                web_sys::console::error_1(&msg.into());
            }));
        });
    }
}

/// Validate and parse a chat request from JSON
#[wasm_bindgen]
pub fn parse_chat_request(json_str: &str) -> Result<JsValue, JsValue> {
    let request: ChatRequest = serde_json::from_str(json_str)
        .map_err(|e| JsValue::from_str(&format!("Invalid JSON: {}", e)))?;

    if request.message.trim().is_empty() {
        return Err(JsValue::from_str("Message is required and must be a non-empty string"));
    }

    serde_wasm_bindgen::to_value(&request)
        .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
}

/// Build OpenAI API request payload
#[wasm_bindgen]
pub fn build_openai_request(
    message: &str,
    system_prompt: &str,
    model: &str,
) -> Result<String, JsValue> {
    let request = OpenAIRequest {
        model: model.to_string(),
        messages: vec![
            OpenAIMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            },
            OpenAIMessage {
                role: "user".to_string(),
                content: message.to_string(),
            },
        ],
        max_tokens: 1024,
        temperature: 0.7,
    };

    serde_json::to_string(&request)
        .map_err(|e| JsValue::from_str(&format!("JSON serialization error: {}", e)))
}

/// Generate a conversation ID
#[wasm_bindgen]
pub fn generate_conversation_id() -> String {
    let uuid = uuid::Uuid::new_v4();
    format!("conv-{}", &uuid.to_string()[..12])
}

/// Get current ISO timestamp
#[wasm_bindgen]
pub fn get_timestamp() -> String {
    // In WASM, we need to get time from JavaScript
    // This is a placeholder that will be overridden by the actual implementation
    let now = js_sys::Date::new_0();
    now.to_iso_string().as_string().unwrap_or_default()
}

/// Create a chat response JSON
#[wasm_bindgen]
pub fn create_chat_response(
    response_text: &str,
    conversation_id: &str,
) -> Result<String, JsValue> {
    let response = ChatResponse {
        response: response_text.to_string(),
        conversation_id: conversation_id.to_string(),
        timestamp: get_timestamp(),
    };

    serde_json::to_string(&response)
        .map_err(|e| JsValue::from_str(&format!("JSON serialization error: {}", e)))
}

/// Create a health response JSON
#[wasm_bindgen]
pub fn create_health_response() -> Result<String, JsValue> {
    let response = HealthResponse {
        status: "healthy".to_string(),
        runtime: "elizaos-rust-wasm".to_string(),
        version: "1.0.0".to_string(),
    };

    serde_json::to_string(&response)
        .map_err(|e| JsValue::from_str(&format!("JSON serialization error: {}", e)))
}

/// Create an error response JSON
#[wasm_bindgen]
pub fn create_error_response(error_message: &str, code: &str) -> Result<String, JsValue> {
    let response = ErrorResponse {
        error: error_message.to_string(),
        code: code.to_string(),
    };

    serde_json::to_string(&response)
        .map_err(|e| JsValue::from_str(&format!("JSON serialization error: {}", e)))
}

/// Process message content (e.g., sanitization, formatting)
#[wasm_bindgen]
pub fn process_message(message: &str) -> String {
    // Trim whitespace and normalize
    let processed = message.trim();
    
    // Could add more processing here:
    // - HTML sanitization
    // - Profanity filtering
    // - Token counting
    // - etc.
    
    processed.to_string()
}

/// Extract response text from OpenAI API response
#[wasm_bindgen]
pub fn extract_openai_response(response_json: &str) -> Result<String, JsValue> {
    #[derive(Deserialize)]
    struct Choice {
        message: MessageContent,
    }

    #[derive(Deserialize)]
    struct MessageContent {
        content: String,
    }

    #[derive(Deserialize)]
    struct OpenAIResponse {
        choices: Vec<Choice>,
    }

    let response: OpenAIResponse = serde_json::from_str(response_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse OpenAI response: {}", e)))?;

    response
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or_else(|| JsValue::from_str("No response content from OpenAI"))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_conversation_id() {
        let id = generate_conversation_id();
        assert!(id.starts_with("conv-"));
        assert!(id.len() > 5);
    }

    #[test]
    fn test_process_message() {
        assert_eq!(process_message("  hello  "), "hello");
        assert_eq!(process_message("test"), "test");
    }

    #[test]
    fn test_create_error_response() {
        let result = create_error_response("Test error", "TEST_CODE");
        assert!(result.is_ok());
        let json = result.unwrap();
        assert!(json.contains("Test error"));
        assert!(json.contains("TEST_CODE"));
    }
}










