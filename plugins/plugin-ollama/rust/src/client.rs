#![allow(missing_docs)]

use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use std::collections::HashMap;
use std::time::Duration;

use crate::config::OllamaConfig;
use crate::error::{OllamaError, Result};
use crate::types::{
    EmbeddingParams, EmbeddingResponse, EmbeddingsRequest, EmbeddingsResponse, GenerateRequest,
    GenerateResponse, ModelInfo, ObjectGenerationParams, ObjectGenerationResponse, PullRequest,
    ShowRequest, TagsResponse, TextGenerationParams, TextGenerationResponse,
};

pub struct OllamaClient {
    config: OllamaConfig,
    http_client: reqwest::Client,
}

impl OllamaClient {
    pub fn new(config: OllamaConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds()))
            .default_headers(headers)
            .build()
            .map_err(|e| OllamaError::config(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self {
            config,
            http_client,
        })
    }

    pub fn config(&self) -> &OllamaConfig {
        &self.config
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let response = self.http_client.get(self.config.tags_url()).send().await?;

        if response.status().is_success() {
            let tags: TagsResponse = response.json().await?;
            Ok(tags.models)
        } else {
            Err(OllamaError::http(
                format!("Failed to list models: {}", response.status()),
                Some(response.status().as_u16()),
            ))
        }
    }

    pub async fn ensure_model_available(&self, model: &str) -> Result<bool> {
        let show_request = ShowRequest {
            model: model.to_string(),
        };

        let response = self
            .http_client
            .post(self.config.show_url())
            .json(&show_request)
            .send()
            .await?;

        if response.status().is_success() {
            return Ok(true);
        }

        let pull_request = PullRequest {
            model: model.to_string(),
            stream: false,
        };

        let response = self
            .http_client
            .post(self.config.pull_url())
            .json(&pull_request)
            .send()
            .await?;

        Ok(response.status().is_success())
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
        self.ensure_model_available(model).await?;

        let mut options: HashMap<String, serde_json::Value> = HashMap::new();
        if let Some(temp) = params.temperature {
            options.insert("temperature".to_string(), serde_json::json!(temp));
        }
        if let Some(top_p) = params.top_p {
            options.insert("top_p".to_string(), serde_json::json!(top_p));
        }
        if let Some(top_k) = params.top_k {
            options.insert("top_k".to_string(), serde_json::json!(top_k));
        }
        if let Some(max_tokens) = params.max_tokens {
            options.insert("num_predict".to_string(), serde_json::json!(max_tokens));
        }
        if let Some(stop) = params.stop {
            options.insert("stop".to_string(), serde_json::json!(stop));
        }

        let request = GenerateRequest {
            model: model.to_string(),
            prompt: params.prompt,
            system: params.system,
            template: None,
            stream: false,
            raw: None,
            format: None,
            options: if options.is_empty() {
                None
            } else {
                Some(options)
            },
        };

        let response = self.send_generate_request(&request).await?;

        Ok(TextGenerationResponse {
            text: response.response,
            model: response.model,
            done: response.done,
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
        self.ensure_model_available(model).await?;

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
            "You must respond with valid JSON only. No markdown, no code blocks.".to_string()
        };

        let mut options: HashMap<String, serde_json::Value> = HashMap::new();
        if let Some(temp) = params.temperature {
            options.insert("temperature".to_string(), serde_json::json!(temp));
        }
        if let Some(max_tokens) = params.max_tokens {
            options.insert("num_predict".to_string(), serde_json::json!(max_tokens));
        }

        let request = GenerateRequest {
            model: model.to_string(),
            prompt: json_prompt,
            system: Some(system),
            template: None,
            stream: false,
            raw: None,
            format: Some("json".to_string()),
            options: if options.is_empty() {
                None
            } else {
                Some(options)
            },
        };

        let response = self.send_generate_request(&request).await?;

        let object = self.extract_json(&response.response)?;

        Ok(ObjectGenerationResponse {
            object,
            model: response.model,
        })
    }

    pub async fn generate_embedding(&self, params: EmbeddingParams) -> Result<EmbeddingResponse> {
        let model = self.config.embedding_model();
        self.ensure_model_available(model).await?;

        let request = EmbeddingsRequest {
            model: model.to_string(),
            prompt: params.text,
        };

        let response = self
            .http_client
            .post(self.config.embeddings_url())
            .json(&request)
            .send()
            .await?;

        if response.status().is_success() {
            let data: EmbeddingsResponse = response.json().await?;
            Ok(EmbeddingResponse {
                embedding: data.embedding,
                model: model.to_string(),
            })
        } else {
            let status = response.status();
            let error_body = response.text().await.unwrap_or_default();
            Err(OllamaError::http(
                format!("Failed to generate embedding: {}", error_body),
                Some(status.as_u16()),
            ))
        }
    }

    async fn send_generate_request(&self, request: &GenerateRequest) -> Result<GenerateResponse> {
        let response = self
            .http_client
            .post(self.config.generate_url())
            .json(request)
            .send()
            .await?;

        if response.status().is_success() {
            let data: GenerateResponse = response.json().await?;
            Ok(data)
        } else {
            let status = response.status();
            let error_body = response.text().await.unwrap_or_default();

            if status.as_u16() == 404 {
                return Err(OllamaError::model_not_found(&request.model));
            }

            Err(OllamaError::http(
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
        !self.config.base_url().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> OllamaConfig {
        OllamaConfig::new()
    }

    #[test]
    fn test_client_creation() {
        let client = OllamaClient::new(test_config());
        assert!(client.is_ok());
    }

    #[test]
    fn test_extract_json_direct() {
        let client = OllamaClient::new(test_config()).unwrap();
        let result = client.extract_json(r#"{"message": "hello"}"#);
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }

    #[test]
    fn test_extract_json_code_block() {
        let client = OllamaClient::new(test_config()).unwrap();
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
        let client = OllamaClient::new(test_config()).unwrap();
        let result = client.extract_json(r#"The result is {"message": "hello"} as requested."#);
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }
}
