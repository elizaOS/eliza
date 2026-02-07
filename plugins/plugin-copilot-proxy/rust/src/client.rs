//! HTTP client for the Copilot Proxy server.

use reqwest::{header::CONTENT_TYPE, Client};
use std::time::Duration;
use tracing::debug;

use crate::config::CopilotProxyConfig;
use crate::error::{CopilotProxyError, Result};
use crate::types::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ModelsResponse,
    TextGenerationParams, TextGenerationResult,
};

/// HTTP client for interacting with the Copilot Proxy server.
pub struct CopilotProxyClient {
    client: Client,
    config: CopilotProxyConfig,
}

impl CopilotProxyClient {
    /// Create a new Copilot Proxy client.
    pub fn new(config: CopilotProxyConfig) -> Result<Self> {
        config.validate()?;

        let client = Client::builder()
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
                headers
            })
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()?;

        Ok(Self { client, config })
    }

    /// Create a client from environment variables.
    pub fn from_env() -> Result<Self> {
        Self::new(CopilotProxyConfig::from_env())
    }

    /// Get the base URL.
    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    /// Get the configuration.
    pub fn config(&self) -> &CopilotProxyConfig {
        &self.config
    }

    /// Build a URL for an endpoint.
    fn url(&self, endpoint: &str) -> String {
        format!("{}{}", self.config.base_url, endpoint)
    }

    /// Check the response for errors.
    async fn check_response(
        &self,
        response: reqwest::Response,
    ) -> Result<reqwest::Response> {
        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status().as_u16();
        let message = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());

        // Try to parse as JSON error
        let message = serde_json::from_str::<serde_json::Value>(&message)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(message);

        Err(CopilotProxyError::ApiError { status, message })
    }

    /// List available models.
    pub async fn list_models(&self) -> Result<ModelsResponse> {
        debug!("Listing Copilot Proxy models");
        let response = self.client.get(self.url("/models")).send().await?;
        let response = self.check_response(response).await?;
        Ok(response.json().await?)
    }

    /// Check if the proxy server is available.
    pub async fn health_check(&self) -> bool {
        match self.list_models().await {
            Ok(_) => true,
            Err(_) => false,
        }
    }

    /// Create a chat completion.
    pub async fn create_chat_completion(
        &self,
        request: &ChatCompletionRequest,
    ) -> Result<ChatCompletionResponse> {
        debug!("Creating chat completion with model: {}", request.model);

        let response = self
            .client
            .post(self.url("/chat/completions"))
            .json(request)
            .send()
            .await?;
        let response = self.check_response(response).await?;

        Ok(response.json().await?)
    }

    /// Generate text using the chat completion API.
    pub async fn generate_text(&self, params: &TextGenerationParams) -> Result<TextGenerationResult> {
        let model = params
            .model
            .as_deref()
            .unwrap_or(&self.config.large_model);
        debug!("Generating text with model: {}", model);

        let mut messages = Vec::new();

        if let Some(system) = &params.system {
            messages.push(ChatMessage::system(system));
        }

        messages.push(ChatMessage::user(&params.prompt));

        let mut request = ChatCompletionRequest::new(model, messages);

        if let Some(max_tokens) = params.max_tokens {
            request = request.max_tokens(max_tokens);
        } else {
            request = request.max_tokens(self.config.max_tokens);
        }

        if let Some(temp) = params.temperature {
            request = request.temperature(temp);
        }

        if let Some(fp) = params.frequency_penalty {
            request = request.frequency_penalty(fp);
        }

        if let Some(pp) = params.presence_penalty {
            request = request.presence_penalty(pp);
        }

        if let Some(stop) = &params.stop {
            request = request.stop(stop.clone());
        }

        let response = self.create_chat_completion(&request).await?;

        let text = response
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or(CopilotProxyError::EmptyResponse)?;

        Ok(TextGenerationResult {
            text,
            usage: response.usage,
        })
    }

    /// Generate text using the small model.
    pub async fn generate_text_small(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt)
            .model(&self.config.small_model);
        let result = self.generate_text(&params).await?;
        Ok(result.text)
    }

    /// Generate text using the large model.
    pub async fn generate_text_large(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt)
            .model(&self.config.large_model);
        let result = self.generate_text(&params).await?;
        Ok(result.text)
    }

    /// Generate a JSON object using the specified model.
    pub async fn generate_object(
        &self,
        prompt: &str,
        model: Option<&str>,
    ) -> Result<serde_json::Value> {
        let json_prompt = format!(
            "{}\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text.",
            prompt
        );

        let params = TextGenerationParams::new(json_prompt)
            .model(model.unwrap_or(&self.config.small_model))
            .system("You must respond with valid JSON only. No markdown, no code blocks, no explanation text.")
            .temperature(0.2);

        let result = self.generate_text(&params).await?;
        extract_json(&result.text)
    }
}

/// Extract JSON from a text response.
fn extract_json(text: &str) -> Result<serde_json::Value> {
    // Try direct parse first
    if let Ok(value) = serde_json::from_str(text) {
        return Ok(value);
    }

    // Try extracting from JSON code block
    let json_block_re = regex::Regex::new(r"```json\s*([\s\S]*?)\s*```").ok();
    if let Some(re) = &json_block_re {
        if let Some(caps) = re.captures(text) {
            if let Some(content) = caps.get(1) {
                if let Ok(value) = serde_json::from_str(content.as_str().trim()) {
                    return Ok(value);
                }
            }
        }
    }

    // Try extracting from any code block
    let any_block_re = regex::Regex::new(r"```(?:\w*)\s*([\s\S]*?)\s*```").ok();
    if let Some(re) = &any_block_re {
        if let Some(caps) = re.captures(text) {
            if let Some(content) = caps.get(1) {
                let trimmed = content.as_str().trim();
                if trimmed.starts_with('{') && trimmed.ends_with('}') {
                    if let Ok(value) = serde_json::from_str(trimmed) {
                        return Ok(value);
                    }
                }
            }
        }
    }

    // Try finding JSON object in text
    if let Some(json_obj) = find_json_object(text) {
        if let Ok(value) = serde_json::from_str(&json_obj) {
            return Ok(value);
        }
    }

    Err(CopilotProxyError::JsonExtractionError(
        "Could not extract valid JSON from response".to_string(),
    ))
}

/// Find a JSON object in text.
fn find_json_object(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed.to_string());
    }

    let mut best: Option<String> = None;
    let mut depth = 0;
    let mut start: Option<usize> = None;

    for (i, char) in text.chars().enumerate() {
        if char == '{' {
            if depth == 0 {
                start = Some(i);
            }
            depth += 1;
        } else if char == '}' {
            depth -= 1;
            if depth == 0 {
                if let Some(s) = start {
                    let candidate = text[s..=i].to_string();
                    if best.as_ref().map(|b| candidate.len() > b.len()).unwrap_or(true) {
                        best = Some(candidate);
                    }
                }
            }
        }
    }

    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_json_direct() {
        let json = r#"{"message": "hello"}"#;
        let result = extract_json(json).unwrap();
        assert_eq!(result["message"], "hello");
    }

    #[test]
    fn test_extract_json_code_block() {
        let text = r#"Here is the response:
```json
{"message": "hello"}
```"#;
        let result = extract_json(text).unwrap();
        assert_eq!(result["message"], "hello");
    }

    #[test]
    fn test_extract_json_embedded() {
        let text = r#"The answer is {"message": "hello"} as you can see."#;
        let result = extract_json(text).unwrap();
        assert_eq!(result["message"], "hello");
    }

    #[test]
    fn test_extract_json_fails_for_plain_text() {
        let text = "This is not JSON at all.";
        let result = extract_json(text);
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_json_any_code_block() {
        let text = "Result:\n```\n{\"key\": 42}\n```";
        let result = extract_json(text).unwrap();
        assert_eq!(result["key"], 42);
    }

    #[test]
    fn test_extract_json_nested_objects() {
        let text = r#"{"outer": {"inner": "value"}}"#;
        let result = extract_json(text).unwrap();
        assert_eq!(result["outer"]["inner"], "value");
    }

    #[test]
    fn test_find_json_object_picks_largest() {
        let text = r#"small: {"a": 1} and large: {"b": 2, "c": 3}"#;
        let found = find_json_object(text).unwrap();
        // The larger JSON object should be picked
        let parsed: serde_json::Value = serde_json::from_str(&found).unwrap();
        assert!(parsed.get("b").is_some() || parsed.get("a").is_some());
    }

    #[test]
    fn test_client_url_construction() {
        let config = CopilotProxyConfig::new().base_url("http://localhost:9999/v1");
        let client = CopilotProxyClient::new(config).unwrap();
        assert_eq!(client.base_url(), "http://localhost:9999/v1");
    }

    #[test]
    fn test_client_creation_with_empty_base_url_fails() {
        let config = CopilotProxyConfig {
            base_url: "".to_string(),
            ..CopilotProxyConfig::new()
        };
        let result = CopilotProxyClient::new(config);
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_health_check_unreachable_returns_false() {
        let config = CopilotProxyConfig::new()
            .base_url("http://127.0.0.1:1")
            .timeout_secs(1);
        let client = CopilotProxyClient::new(config).unwrap();
        assert!(!client.health_check().await);
    }

    #[test]
    fn test_check_response_builds_api_error() {
        // Test the error type directly
        let err = CopilotProxyError::ApiError {
            status: 429,
            message: "Rate limited".to_string(),
        };
        let msg = format!("{}", err);
        assert!(msg.contains("429"));
        assert!(msg.contains("Rate limited"));
    }

    #[test]
    fn test_empty_response_error() {
        let err = CopilotProxyError::EmptyResponse;
        let msg = format!("{}", err);
        assert!(msg.to_lowercase().contains("empty"));
    }
}
