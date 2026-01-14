#![allow(missing_docs)]

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::time::Duration;
use tracing::{debug, error};

use crate::config::OpenRouterConfig;
use crate::error::{OpenRouterError, Result};
use crate::types::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage, EmbeddingParams, EmbeddingResponse,
    EmbeddingsRequest, EmbeddingsResponseBody, ModelInfo, ModelsResponse, ObjectGenerationParams,
    ObjectGenerationResponse, ResponseFormat, TextGenerationParams, TextGenerationResponse,
};

pub struct OpenRouterClient {
    config: OpenRouterConfig,
    http_client: reqwest::Client,
}

impl OpenRouterClient {
    pub fn new(config: OpenRouterConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.api_key()))
                .map_err(|e| OpenRouterError::config(format!("Invalid API key format: {}", e)))?,
        );
        headers.insert(
            "HTTP-Referer",
            HeaderValue::from_static("https://elizaos.ai"),
        );
        headers.insert("X-Title", HeaderValue::from_static("ElizaOS"));

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds()))
            .default_headers(headers)
            .build()
            .map_err(|e| OpenRouterError::config(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self {
            config,
            http_client,
        })
    }

    pub fn config(&self) -> &OpenRouterConfig {
        &self.config
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let response = self
            .http_client
            .get(self.config.models_url())
            .send()
            .await?;

        if response.status().is_success() {
            let data: ModelsResponse = response.json().await?;
            Ok(data.data)
        } else {
            Err(OpenRouterError::http(
                format!("Failed to list models: {}", response.status()),
                Some(response.status().as_u16()),
            ))
        }
    }

    pub async fn generate_text_small(
        &self,
        params: TextGenerationParams,
    ) -> Result<TextGenerationResponse> {
        self.generate_text_with_model(params, self.config.small_model())
            .await
    }

    pub async fn generate_text_large(
        &self,
        params: TextGenerationParams,
    ) -> Result<TextGenerationResponse> {
        self.generate_text_with_model(params, self.config.large_model())
            .await
    }

    pub async fn generate_text_with_model(
        &self,
        params: TextGenerationParams,
        model: &str,
    ) -> Result<TextGenerationResponse> {
        debug!(model = %model, "Generating text");

        let mut messages = Vec::new();
        if let Some(system) = &params.system {
            messages.push(ChatMessage::system(system));
        }
        messages.push(ChatMessage::user(&params.prompt));

        let request = ChatCompletionRequest {
            model: model.to_string(),
            messages,
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            top_p: params.top_p,
            frequency_penalty: params.frequency_penalty,
            presence_penalty: params.presence_penalty,
            stop: params.stop,
            response_format: None,
        };

        let response = self.send_chat_request(&request).await?;

        let text = response
            .choices
            .first()
            .map(|c| c.message.content.clone())
            .unwrap_or_default();

        Ok(TextGenerationResponse {
            text,
            model: response.model,
            usage: response.usage,
        })
    }

    pub async fn generate_object_small(
        &self,
        params: ObjectGenerationParams,
    ) -> Result<ObjectGenerationResponse> {
        self.generate_object_with_model(params, self.config.small_model())
            .await
    }

    pub async fn generate_object_large(
        &self,
        params: ObjectGenerationParams,
    ) -> Result<ObjectGenerationResponse> {
        self.generate_object_with_model(params, self.config.large_model())
            .await
    }

    pub async fn generate_object_with_model(
        &self,
        params: ObjectGenerationParams,
        model: &str,
    ) -> Result<ObjectGenerationResponse> {
        debug!(model = %model, "Generating JSON object");

        let json_prompt = if params.prompt.contains("```json")
            || params.prompt.contains("respond with valid JSON")
        {
            params.prompt.clone()
        } else {
            format!(
                "{}\nPlease respond with valid JSON only, without any explanations, \
                 markdown formatting, or additional text.",
                params.prompt
            )
        };

        let system = if let Some(user_system) = &params.system {
            format!("{}\nYou must respond with valid JSON only.", user_system)
        } else {
            "You must respond with valid JSON only. No markdown, no code blocks.".to_string()
        };

        let messages = vec![
            ChatMessage::system(&system),
            ChatMessage::user(&json_prompt),
        ];

        let request = ChatCompletionRequest {
            model: model.to_string(),
            messages,
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            top_p: None,
            frequency_penalty: None,
            presence_penalty: None,
            stop: None,
            response_format: Some(ResponseFormat {
                format_type: "json_object".to_string(),
            }),
        };

        let response = self.send_chat_request(&request).await?;

        let text = response
            .choices
            .first()
            .map(|c| c.message.content.clone())
            .unwrap_or_default();

        let object = self.extract_json(&text)?;

        Ok(ObjectGenerationResponse {
            object,
            model: response.model,
            usage: response.usage,
        })
    }

    pub async fn generate_embedding(&self, params: EmbeddingParams) -> Result<EmbeddingResponse> {
        let model = self.config.embedding_model();
        debug!(model = %model, "Generating embedding");

        let request = EmbeddingsRequest {
            model: model.to_string(),
            input: params.text,
        };

        let response = self
            .http_client
            .post(self.config.embeddings_url())
            .json(&request)
            .send()
            .await?;

        if response.status().is_success() {
            let data: EmbeddingsResponseBody = response.json().await?;
            if let Some(first) = data.data.first() {
                return Ok(EmbeddingResponse {
                    embedding: first.embedding.clone(),
                    model: data.model,
                });
            }
            Err(OpenRouterError::json("API returned no embedding data"))
        } else {
            let status = response.status();
            let error_body = response.text().await.unwrap_or_default();
            Err(OpenRouterError::http(
                format!("Failed to generate embedding: {}", error_body),
                Some(status.as_u16()),
            ))
        }
    }

    async fn send_chat_request(
        &self,
        request: &ChatCompletionRequest,
    ) -> Result<ChatCompletionResponse> {
        let response = self
            .http_client
            .post(self.config.chat_completions_url())
            .json(request)
            .send()
            .await?;

        let status = response.status();

        if status.is_success() {
            let body: ChatCompletionResponse = response.json().await?;
            Ok(body)
        } else {
            if status.as_u16() == 429 {
                return Err(OpenRouterError::rate_limit(60));
            }

            let error_body = response.text().await.unwrap_or_default();
            Err(OpenRouterError::http(
                format!("API request failed: {} - {}", status, error_body),
                Some(status.as_u16()),
            ))
        }
    }

    fn extract_json(&self, text: &str) -> Result<serde_json::Value> {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
            return Ok(value);
        }

        if let Some(json_str) = self.extract_from_code_block(text) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json_str) {
                return Ok(value);
            }
        }

        if let Some(json_str) = self.find_json_object(text) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json_str) {
                return Ok(value);
            }
        }

        error!("Failed to extract JSON from response: {}", text);
        Ok(serde_json::json!({}))
    }

    fn extract_from_code_block(&self, text: &str) -> Option<String> {
        let json_block_re = regex::Regex::new(r"```json\s*([\s\S]*?)\s*```").ok()?;
        if let Some(caps) = json_block_re.captures(text) {
            return caps.get(1).map(|m| m.as_str().trim().to_string());
        }

        let any_block_re = regex::Regex::new(r"```(?:\w*)\s*([\s\S]*?)\s*```").ok()?;
        for caps in any_block_re.captures_iter(text) {
            if let Some(content) = caps.get(1) {
                let content_str = content.as_str().trim();
                if content_str.starts_with('{') && content_str.ends_with('}') {
                    return Some(content_str.to_string());
                }
            }
        }

        None
    }

    fn find_json_object(&self, text: &str) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            return Some(trimmed.to_string());
        }

        let mut best: Option<&str> = None;
        let mut depth = 0;
        let mut start = None;

        for (i, c) in text.char_indices() {
            match c {
                '{' => {
                    if depth == 0 {
                        start = Some(i);
                    }
                    depth += 1;
                }
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        if let Some(s) = start {
                            let candidate = &text[s..=i];
                            if best.is_none_or(|b| candidate.len() > b.len()) {
                                best = Some(candidate);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        best.map(|s| s.to_string())
    }

    pub fn is_configured(&self) -> bool {
        !self.config.api_key().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> OpenRouterConfig {
        OpenRouterConfig::new("test-key").unwrap()
    }

    #[test]
    fn test_client_creation() {
        let client = OpenRouterClient::new(test_config());
        assert!(client.is_ok());
    }

    #[test]
    fn test_extract_json_direct() {
        let client = OpenRouterClient::new(test_config()).unwrap();
        let result = client.extract_json(r#"{"message": "hello"}"#);
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }

    #[test]
    fn test_extract_json_code_block() {
        let client = OpenRouterClient::new(test_config()).unwrap();
        let result = client.extract_json(
            r#"Here is the JSON:
```json
{"message": "hello"}
```"#,
        );
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }
}
