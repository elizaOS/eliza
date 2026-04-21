//! HTTP Outcalls for OpenAI Integration
//!
//! This module provides HTTP outcalls to OpenAI's API from ICP canisters.
//!
//! ## Direct OpenAI API Access
//!
//! OpenAI's API (api.openai.com) is IPv6-enabled, so we can call it directly from ICP.
//! The API key is stored in canister state - for production, consider using vetKeys
//! for secure key management.
//!
//! ## Architecture
//!
//! ```
//! ┌─────────────┐                    ┌────────────────┐
//! │   Canister  │───────────────────▶│   OpenAI API   │
//! │  (ICP)      │◀───────────────────│  (IPv6-ready)  │
//! └─────────────┘                    └────────────────┘
//! ```
//!
//! ## Security Notes
//!
//! 1. API key is stored in canister state (visible to controllers)
//! 2. For production, use vetKeys to encrypt the API key
//! 3. Implement idempotency - POST requests may be sent multiple times due to consensus

use crate::types::{
    CanisterError, CanisterResult, OpenAIChatMessage, OpenAIChatRequest, OpenAIChatResponse,
    OpenAIConfig,
};
use ic_cdk::api::management_canister::http_request::{
    http_request, CanisterHttpRequestArgument, HttpHeader, HttpMethod, HttpResponse,
    TransformArgs, TransformContext, TransformFunc,
};
use serde_json;

/// Default cycles to attach for HTTP outcalls
/// Adjust based on expected response size and current pricing
const DEFAULT_HTTP_CYCLES: u128 = 230_850_258_000;

/// Maximum response bytes (2MB limit on ICP)
const MAX_RESPONSE_BYTES: u64 = 2_000_000;

/// Transform function to reduce response size
/// This is called by the IC to process the HTTP response
#[ic_cdk::query]
pub fn transform_openai_response(args: TransformArgs) -> HttpResponse {
    let mut response = args.response;
    // Strip headers to reduce response size and ensure consensus
    response.headers = vec![];
    response
}

/// OpenAI HTTP client for ICP canisters
pub struct OpenAIClient {
    config: OpenAIConfig,
}

impl OpenAIClient {
    /// Create a new OpenAI client with the given configuration
    pub fn new(config: OpenAIConfig) -> Self {
        Self { config }
    }

    /// Create a client with default configuration
    pub fn default() -> Self {
        Self::new(OpenAIConfig::default())
    }

    /// Check if the client is properly configured with an API key
    pub fn is_configured(&self) -> bool {
        self.config.is_configured()
    }

    /// Generate a chat completion using OpenAI API directly
    ///
    /// # Arguments
    /// * `system_prompt` - The system message to set context
    /// * `user_message` - The user's message
    /// * `conversation_history` - Previous messages for context
    ///
    /// # Returns
    /// The assistant's response text
    pub async fn chat_completion(
        &self,
        system_prompt: &str,
        user_message: &str,
        conversation_history: &[(String, String)], // (role, content)
    ) -> CanisterResult<String> {
        // Check for API key
        let api_key = self.config.api_key.as_ref().ok_or_else(|| {
            CanisterError::InvalidInput("OpenAI API key not configured".to_string())
        })?;

        // Build messages array
        let mut messages = Vec::new();

        // Add system message
        messages.push(OpenAIChatMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
        });

        // Add conversation history
        for (role, content) in conversation_history {
            messages.push(OpenAIChatMessage {
                role: role.clone(),
                content: content.clone(),
            });
        }

        // Add current user message
        messages.push(OpenAIChatMessage {
            role: "user".to_string(),
            content: user_message.to_string(),
        });

        // Build request body
        let request_body = OpenAIChatRequest {
            model: self.config.model.clone(),
            messages,
            temperature: self.config.temperature,
            max_tokens: self.config.max_tokens,
        };

        let body_json = serde_json::to_string(&request_body).map_err(|e| {
            CanisterError::SerializationError(format!("Failed to serialize request: {}", e))
        })?;

        // Generate idempotency key from message content and timestamp
        let idempotency_key = generate_idempotency_key(user_message);

        // Build HTTP request with Authorization header
        let request = CanisterHttpRequestArgument {
            url: self.config.api_url.clone(),
            max_response_bytes: Some(MAX_RESPONSE_BYTES),
            method: HttpMethod::POST,
            headers: vec![
                HttpHeader {
                    name: "Content-Type".to_string(),
                    value: "application/json".to_string(),
                },
                HttpHeader {
                    name: "Authorization".to_string(),
                    value: format!("Bearer {}", api_key),
                },
                HttpHeader {
                    name: "Idempotency-Key".to_string(),
                    value: idempotency_key,
                },
            ],
            body: Some(body_json.into_bytes()),
            transform: Some(TransformContext {
                function: TransformFunc(candid::Func {
                    principal: ic_cdk::api::id(),
                    method: "transform_openai_response".to_string(),
                }),
                context: vec![],
            }),
        };

        // Make the HTTP outcall
        let (response,) = http_request(request, DEFAULT_HTTP_CYCLES)
            .await
            .map_err(|(code, msg)| {
                CanisterError::HttpOutcallError(format!(
                    "HTTP request failed: code={:?}, msg={}",
                    code, msg
                ))
            })?;

        // Check status
        if response.status != 200u8 {
            let body_text = String::from_utf8_lossy(&response.body);
            return Err(CanisterError::HttpOutcallError(format!(
                "OpenAI API returned status {}: {}",
                response.status, body_text
            )));
        }

        // Parse response
        let chat_response: OpenAIChatResponse =
            serde_json::from_slice(&response.body).map_err(|e| {
                CanisterError::SerializationError(format!("Failed to parse response: {}", e))
            })?;

        // Extract assistant message
        chat_response
            .choices
            .first()
            .map(|choice| choice.message.content.clone())
            .ok_or_else(|| CanisterError::InternalError("No response from OpenAI".to_string()))
    }

    /// Simple text generation without conversation history
    pub async fn generate_text(
        &self,
        system_prompt: &str,
        user_message: &str,
    ) -> CanisterResult<String> {
        self.chat_completion(system_prompt, user_message, &[]).await
    }
}

/// Generate an idempotency key from message content
fn generate_idempotency_key(message: &str) -> String {
    use sha2::{Digest, Sha256};

    let time = ic_cdk::api::time();
    let caller = ic_cdk::api::caller();

    let mut hasher = Sha256::new();
    hasher.update(time.to_be_bytes());
    hasher.update(caller.as_slice());
    hasher.update(message.as_bytes());

    let result = hasher.finalize();
    format!("{:x}", result)
}

/// Build conversation history from recent messages
pub fn build_conversation_history(
    messages: &[crate::types::Memory],
    agent_id: &str,
    max_messages: usize,
) -> Vec<(String, String)> {
    messages
        .iter()
        .rev()
        .take(max_messages)
        .rev()
        .filter_map(|m| {
            let text = m.content.text.as_ref()?;
            let role = if m.entity_id.as_str() == agent_id {
                "assistant"
            } else {
                "user"
            };
            Some((role.to_string(), text.clone()))
        })
        .collect()
}

/// Check if OpenAI integration is available
/// Returns true if API key is configured
pub fn is_openai_configured(config: &OpenAIConfig) -> bool {
    config.is_configured()
}

#[cfg(test)]
mod tests {
    use super::*;

    // This test requires ICP canister runtime - skip in regular tests
    #[test]
    #[ignore = "Requires ICP canister runtime for ic_cdk::api::time()"]
    fn test_generate_idempotency_key() {
        let key = generate_idempotency_key("test message");
        assert_eq!(key.len(), 64); // SHA256 hex is 64 chars
    }

    #[test]
    fn test_is_openai_configured() {
        let mut config = OpenAIConfig::default();
        assert!(!is_openai_configured(&config)); // No API key

        config.api_key = Some("sk-test-key".to_string());
        assert!(is_openai_configured(&config)); // Has API key
        
        config.api_key = Some("".to_string());
        assert!(!is_openai_configured(&config)); // Empty API key
    }
}
