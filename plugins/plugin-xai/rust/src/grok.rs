#![allow(missing_docs)]
//! xAI Grok Client
//!
//! Async HTTP client for xAI's Grok API.

use futures::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    Client,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::debug;

use crate::error::{Result, XAIError};

/// Grok API configuration.
#[derive(Debug, Clone)]
pub struct GrokConfig {
    /// API key
    pub api_key: String,
    /// Base URL for API requests
    pub base_url: String,
    /// Model for small/fast tasks
    pub small_model: String,
    /// Model for large/complex tasks
    pub large_model: String,
    /// Model for embeddings
    pub embedding_model: String,
    /// Request timeout in seconds
    pub timeout_secs: u64,
}

impl GrokConfig {
    /// Create a new configuration with the given API key.
    pub fn new(api_key: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            small_model: "grok-3-mini".to_string(),
            large_model: "grok-3".to_string(),
            embedding_model: "grok-embedding".to_string(),
            timeout_secs: 60,
        }
    }

    /// Create configuration from environment variables.
    pub fn from_env() -> anyhow::Result<Self> {
        let api_key =
            std::env::var("XAI_API_KEY").map_err(|_| anyhow::anyhow!("XAI_API_KEY is required"))?;

        let mut config = Self::new(&api_key);

        if let Ok(base_url) = std::env::var("XAI_BASE_URL") {
            config.base_url = base_url;
        }
        if let Ok(model) = std::env::var("XAI_SMALL_MODEL") {
            config.small_model = model;
        }
        if let Ok(model) = std::env::var("XAI_MODEL") {
            config.large_model = model;
        } else if let Ok(model) = std::env::var("XAI_LARGE_MODEL") {
            config.large_model = model;
        }
        if let Ok(model) = std::env::var("XAI_EMBEDDING_MODEL") {
            config.embedding_model = model;
        }

        Ok(config)
    }

    /// Set custom base URL.
    pub fn base_url(mut self, url: &str) -> Self {
        self.base_url = url.to_string();
        self
    }

    /// Set small model.
    pub fn small_model(mut self, model: &str) -> Self {
        self.small_model = model.to_string();
        self
    }

    /// Set large model.
    pub fn large_model(mut self, model: &str) -> Self {
        self.large_model = model.to_string();
        self
    }
}

/// Parameters for text generation.
#[derive(Debug, Clone, Serialize)]
pub struct TextGenerationParams {
    /// User prompt
    pub prompt: String,
    /// System message
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// Temperature (0.0 - 2.0)
    pub temperature: f32,
    /// Maximum tokens to generate
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Stop sequences
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
}

impl TextGenerationParams {
    /// Create new parameters with the given prompt.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            system: None,
            temperature: 0.7,
            max_tokens: None,
            stop: None,
        }
    }

    /// Set system message.
    pub fn system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    /// Set temperature.
    pub fn temperature(mut self, temp: f32) -> Self {
        self.temperature = temp;
        self
    }

    /// Set max tokens.
    pub fn max_tokens(mut self, tokens: u32) -> Self {
        self.max_tokens = Some(tokens);
        self
    }
}

/// Parameters for embedding generation.
#[derive(Debug, Clone, Serialize)]
pub struct EmbeddingParams {
    /// Text to embed
    pub text: String,
    /// Model to use (optional, uses default if not specified)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl EmbeddingParams {
    /// Create new parameters with the given text.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            model: None,
        }
    }
}

/// Token usage information.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TokenUsage {
    /// Prompt tokens
    pub prompt_tokens: u64,
    /// Completion tokens
    pub completion_tokens: u64,
    /// Total tokens
    pub total_tokens: u64,
}

/// Result of text generation.
#[derive(Debug, Clone)]
pub struct TextGenerationResult {
    /// Generated text
    pub text: String,
    /// Token usage
    pub usage: TokenUsage,
}

/// Chat message for API requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Role (system, user, assistant)
    pub role: String,
    /// Message content
    pub content: String,
}

/// xAI Grok API client.
pub struct GrokClient {
    client: Client,
    config: GrokConfig,
}

impl GrokClient {
    /// Create a new Grok client.
    pub fn new(config: GrokConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.api_key))
                .map_err(|e| XAIError::ConfigError(e.to_string()))?,
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let client = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()?;

        Ok(Self { client, config })
    }

    fn url(&self, endpoint: &str) -> String {
        format!("{}{}", self.config.base_url, endpoint)
    }

    async fn check_response(&self, response: reqwest::Response) -> Result<reqwest::Response> {
        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status().as_u16();
        let text = response.text().await?;

        let message = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => v["error"]["message"]
                .as_str()
                .map(String::from)
                .unwrap_or(text),
            Err(_) => text,
        };

        Err(XAIError::GrokError { status, message })
    }

    // =========================================================================
    // Text Generation
    // =========================================================================

    /// Generate text using Grok.
    pub async fn generate_text(
        &self,
        params: &TextGenerationParams,
        use_large_model: bool,
    ) -> Result<TextGenerationResult> {
        let model = if use_large_model {
            &self.config.large_model
        } else {
            &self.config.small_model
        };

        debug!("Generating text with model: {}", model);

        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(ref system) = params.system {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system.clone(),
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: params.prompt.clone(),
        });

        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "temperature": params.temperature,
        });

        if let Some(max) = params.max_tokens {
            body["max_tokens"] = serde_json::json!(max);
        }
        if let Some(ref stop) = params.stop {
            body["stop"] = serde_json::json!(stop);
        }

        let response = self
            .client
            .post(self.url("/chat/completions"))
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let content = data["choices"][0]["message"]["content"]
            .as_str()
            .ok_or(XAIError::EmptyResponse)?
            .to_string();

        let usage_data = &data["usage"];
        let usage = TokenUsage {
            prompt_tokens: usage_data["prompt_tokens"].as_u64().expect("prompt_tokens"),
            completion_tokens: usage_data["completion_tokens"]
                .as_u64()
                .expect("completion_tokens"),
            total_tokens: usage_data["total_tokens"].as_u64().expect("total_tokens"),
        };

        Ok(TextGenerationResult {
            text: content,
            usage,
        })
    }

    /// Stream text generation.
    pub async fn stream_text(
        &self,
        params: &TextGenerationParams,
        use_large_model: bool,
    ) -> Result<impl futures::Stream<Item = Result<String>>> {
        let model = if use_large_model {
            &self.config.large_model
        } else {
            &self.config.small_model
        };

        debug!("Streaming text with model: {}", model);

        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(ref system) = params.system {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: system.clone(),
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: params.prompt.clone(),
        });

        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "temperature": params.temperature,
            "stream": true,
        });

        if let Some(max) = params.max_tokens {
            body["max_tokens"] = serde_json::json!(max);
        }

        let response = self
            .client
            .post(self.url("/chat/completions"))
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;

        let stream = response.bytes_stream().filter_map(|result| async move {
            match result {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.lines() {
                        if !line.starts_with("data: ") {
                            continue;
                        }
                        let data = &line[6..];
                        if data == "[DONE]" {
                            return None;
                        }
                        if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) {
                            if let Some(content) = chunk["choices"][0]["delta"]["content"].as_str()
                            {
                                return Some(Ok(content.to_string()));
                            }
                        }
                    }
                    None
                }
                Err(e) => Some(Err(XAIError::HttpError(e))),
            }
        });

        Ok(stream)
    }

    // =========================================================================
    // Embeddings
    // =========================================================================

    /// Create an embedding for text.
    pub async fn create_embedding(&self, params: &EmbeddingParams) -> Result<Vec<f32>> {
        let model = params
            .model
            .as_deref()
            .unwrap_or(&self.config.embedding_model);
        debug!("Creating embedding with model: {}", model);

        let body = serde_json::json!({
            "model": model,
            "input": params.text,
        });

        let response = self
            .client
            .post(self.url("/embeddings"))
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        let embedding: Vec<f32> = data["data"][0]["embedding"]
            .as_array()
            .ok_or(XAIError::EmptyResponse)?
            .iter()
            .filter_map(|v| v.as_f64().map(|f| f as f32))
            .collect();

        if embedding.is_empty() {
            return Err(XAIError::EmptyResponse);
        }

        Ok(embedding)
    }

    // =========================================================================
    // Models
    // =========================================================================

    /// List available models.
    pub async fn list_models(&self) -> Result<Vec<serde_json::Value>> {
        let response = self.client.get(self.url("/models")).send().await?;
        let response = self.check_response(response).await?;
        let data: serde_json::Value = response.json().await?;

        Ok(data["data"]
            .as_array()
            .ok_or(XAIError::EmptyResponse)?
            .clone())
    }
}
