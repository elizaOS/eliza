use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use std::time::Duration;
use tracing::{debug, error};

use crate::config::AnthropicConfig;
use crate::error::{AnthropicError, Result};
use crate::models::Model;
use crate::types::{
    ContentBlock, ErrorResponse, Message, MessagesRequest, MessagesResponse,
    ObjectGenerationParams, ObjectGenerationResponse, TextGenerationParams, TextGenerationResponse,
};

/// HTTP client for interacting with the Anthropic Claude API.
///
/// Provides methods for text generation and structured JSON object generation
/// using various Claude models.
pub struct AnthropicClient {
    config: AnthropicConfig,
    http_client: reqwest::Client,
}

impl AnthropicClient {
    /// Creates a new Anthropic client with the given configuration.
    ///
    /// # Errors
    ///
    /// Returns an error if the HTTP client cannot be built or if the
    /// configuration contains invalid values.
    pub fn new(config: AnthropicConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(config.api_key())
                .map_err(|e| AnthropicError::config(format!("Invalid API key format: {}", e)))?,
        );
        headers.insert(
            "anthropic-version",
            HeaderValue::from_str(config.api_version()).map_err(|e| {
                AnthropicError::config(format!("Invalid API version format: {}", e))
            })?,
        );

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds()))
            .default_headers(headers)
            .build()
            .map_err(|e| AnthropicError::config(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self {
            config,
            http_client,
        })
    }

    /// Returns a reference to the client's configuration.
    pub fn config(&self) -> &AnthropicConfig {
        &self.config
    }

    /// Generates text using the configured small model (typically Haiku).
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails or the response cannot be parsed.
    pub async fn generate_text_small(
        &self,
        params: TextGenerationParams,
    ) -> Result<TextGenerationResponse> {
        self.generate_text_with_model(params, self.config.small_model())
            .await
    }

    /// Generates text using the configured large model (typically Sonnet).
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails or the response cannot be parsed.
    pub async fn generate_text_large(
        &self,
        params: TextGenerationParams,
    ) -> Result<TextGenerationResponse> {
        self.generate_text_with_model(params, self.config.large_model())
            .await
    }

    /// Generates text using a specific model.
    ///
    /// # Errors
    ///
    /// Returns an error if both temperature and top_p are specified,
    /// if the API request fails, or if the response cannot be parsed.
    pub async fn generate_text_with_model(
        &self,
        params: TextGenerationParams,
        model: &Model,
    ) -> Result<TextGenerationResponse> {
        if params.temperature.is_some() && params.top_p.is_some() {
            return Err(AnthropicError::invalid_parameter(
                "temperature/top_p",
                "Cannot specify both temperature and top_p. Use only one.",
            ));
        }

        debug!(model = %model, "Generating text");

        let messages = if let Some(msgs) = params.messages {
            msgs
        } else {
            vec![Message::user(&params.prompt)]
        };

        let max_tokens = params.max_tokens.unwrap_or(model.default_max_tokens());

        let request = MessagesRequest {
            model: model.id().to_string(),
            max_tokens,
            messages,
            system: params.system,
            temperature: params.temperature,
            top_p: params.top_p,
            stop_sequences: params.stop_sequences,
            metadata: None,
        };

        let response = self.send_request(&request).await?;

        let mut text_parts: Vec<String> = Vec::new();
        let mut thinking_parts: Vec<String> = Vec::new();

        for block in &response.content {
            match block {
                ContentBlock::Text { text } => text_parts.push(text.clone()),
                ContentBlock::Thinking { thinking } => thinking_parts.push(thinking.clone()),
                _ => {}
            }
        }

        let text = text_parts.join("");
        let thinking = if thinking_parts.is_empty() {
            None
        } else {
            Some(thinking_parts.join(""))
        };

        Ok(TextGenerationResponse {
            text,
            thinking,
            usage: response.usage,
            stop_reason: response.stop_reason.unwrap_or_default(),
            model: response.model,
        })
    }

    /// Generates a JSON object using the configured small model.
    ///
    /// The model is instructed to return valid JSON only.
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails or the response
    /// cannot be parsed as valid JSON.
    pub async fn generate_object_small(
        &self,
        params: ObjectGenerationParams,
    ) -> Result<ObjectGenerationResponse> {
        self.generate_object_with_model(params, self.config.small_model())
            .await
    }

    /// Generates a JSON object using the configured large model.
    ///
    /// The model is instructed to return valid JSON only.
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails or the response
    /// cannot be parsed as valid JSON.
    pub async fn generate_object_large(
        &self,
        params: ObjectGenerationParams,
    ) -> Result<ObjectGenerationResponse> {
        self.generate_object_with_model(params, self.config.large_model())
            .await
    }

    /// Generates a JSON object using a specific model.
    ///
    /// The model is instructed to return valid JSON only. The response
    /// text is parsed and validated as JSON before being returned.
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails or the response
    /// cannot be parsed as valid JSON.
    pub async fn generate_object_with_model(
        &self,
        params: ObjectGenerationParams,
        model: &Model,
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

        let system = if let Some(user_system) = params.system {
            format!("{}\nYou must respond with valid JSON only.", user_system)
        } else {
            "You must respond with valid JSON only. No markdown, no code blocks, no explanation text.".to_string()
        };

        let messages = vec![Message::user(&json_prompt)];
        let max_tokens = params.max_tokens.unwrap_or(model.default_max_tokens());

        let request = MessagesRequest {
            model: model.id().to_string(),
            max_tokens,
            messages,
            system: Some(system),
            temperature: params.temperature,
            top_p: None,
            stop_sequences: None,
            metadata: None,
        };

        let response = self.send_request(&request).await?;

        let text = response
            .content
            .iter()
            .filter_map(|block| block.as_text())
            .collect::<Vec<_>>()
            .join("");

        let object = self.extract_json(&text)?;

        Ok(ObjectGenerationResponse {
            object,
            usage: response.usage,
            model: response.model,
        })
    }

    async fn send_request(&self, request: &MessagesRequest) -> Result<MessagesResponse> {
        let url = self.config.messages_url();

        let response = self.http_client.post(&url).json(request).send().await?;

        let status = response.status();

        if status.is_success() {
            let body = response.json::<MessagesResponse>().await?;
            Ok(body)
        } else {
            let error_body = response.text().await.unwrap_or_default();

            if let Ok(error_response) = serde_json::from_str::<ErrorResponse>(&error_body) {
                if status.as_u16() == 429 {
                    return Err(AnthropicError::RateLimitError {
                        retry_after_seconds: 60,
                    });
                }

                return Err(AnthropicError::ApiError {
                    error_type: error_response.error.error_type,
                    message: error_response.error.message,
                });
            }

            Err(AnthropicError::http(
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
        Err(AnthropicError::json_generation(
            "Could not extract valid JSON from model response",
        ))
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
                            if best.is_none() || candidate.len() > best.unwrap().len() {
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
}

impl AnthropicClient {
    /// Returns true if the client has a non-empty API key configured.
    pub fn is_configured(&self) -> bool {
        !self.config.api_key().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> AnthropicConfig {
        AnthropicConfig::new("test-api-key").unwrap()
    }

    #[test]
    fn test_client_creation() {
        let client = AnthropicClient::new(test_config());
        assert!(client.is_ok());
    }

    #[test]
    fn test_extract_json_direct() {
        let client = AnthropicClient::new(test_config()).unwrap();
        let result = client.extract_json(r#"{"message": "hello"}"#);
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }

    #[test]
    fn test_extract_json_code_block() {
        let client = AnthropicClient::new(test_config()).unwrap();
        let result = client.extract_json(
            r#"Here is the JSON:
```json
{"message": "hello"}
```"#,
        );
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }

    #[test]
    fn test_extract_json_embedded() {
        let client = AnthropicClient::new(test_config()).unwrap();
        let result = client.extract_json(r#"The result is {"message": "hello"} as requested."#);
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }
}
