#![allow(missing_docs)]

use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use std::time::Duration;
use tracing::{debug, error};

use crate::config::GoogleGenAIConfig;
use crate::error::{GoogleGenAIError, Result};
use crate::models::Model;
use crate::types::{
    Content, EmbedContentRequest, EmbedContentResponse, EmbeddingParams, EmbeddingResponse,
    ErrorResponse, GenerateContentRequest, GenerateContentResponse, GenerationConfig,
    ImageDescriptionParams, ImageDescriptionResponse, InlineData, ObjectGenerationParams,
    ObjectGenerationResponse, Part, TextGenerationParams, TextGenerationResponse,
};

pub struct GoogleGenAIClient {
    config: GoogleGenAIConfig,
    http_client: reqwest::Client,
}

impl GoogleGenAIClient {
    pub fn new(config: GoogleGenAIConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let http_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds()))
            .default_headers(headers)
            .build()
            .map_err(|e| GoogleGenAIError::config(format!("Failed to build HTTP client: {}", e)))?;

        Ok(Self {
            config,
            http_client,
        })
    }

    pub fn config(&self) -> &GoogleGenAIConfig {
        &self.config
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
        model: &Model,
    ) -> Result<TextGenerationResponse> {
        debug!(model = %model, "Generating text");

        let url = self.config.generate_content_url(model);

        let mut request = GenerateContentRequest {
            contents: vec![Content {
                parts: vec![Part {
                    text: Some(params.prompt.clone()),
                    inline_data: None,
                }],
                role: None,
            }],
            generation_config: Some(GenerationConfig {
                temperature: params.temperature,
                top_k: params.top_k,
                top_p: params.top_p,
                max_output_tokens: Some(params.max_tokens.unwrap_or(model.default_max_tokens())),
                stop_sequences: params.stop_sequences,
                response_mime_type: None,
            }),
            safety_settings: None,
            system_instruction: None,
        };

        if let Some(system) = params.system {
            request.system_instruction = Some(Content {
                parts: vec![Part {
                    text: Some(system),
                    inline_data: None,
                }],
                role: None,
            });
        }

        let response: GenerateContentResponse = self.send_request(&url, &request).await?;
        let text = response.get_text();
        let usage = response.usage_metadata.unwrap_or_default();

        Ok(TextGenerationResponse {
            text,
            usage,
            model: model.id().to_string(),
        })
    }

    pub async fn generate_embedding(&self, params: EmbeddingParams) -> Result<EmbeddingResponse> {
        let model = self.config.embedding_model();
        let url = self.config.embed_content_url(model);

        debug!(model = %model, "Generating embedding");

        let request = EmbedContentRequest {
            content: Content {
                parts: vec![Part {
                    text: Some(params.text),
                    inline_data: None,
                }],
                role: None,
            },
        };

        let response: EmbedContentResponse = self.send_request(&url, &request).await?;

        Ok(EmbeddingResponse {
            embedding: response.embedding.values,
            model: model.id().to_string(),
        })
    }

    pub async fn describe_image(
        &self,
        params: ImageDescriptionParams,
    ) -> Result<ImageDescriptionResponse> {
        let model = self.config.image_model();
        let url = self.config.generate_content_url(model);

        debug!(model = %model, "Describing image");

        let image_data = self.fetch_image(&params.image_url).await?;

        let prompt = params.prompt.unwrap_or_else(|| {
            "Please analyze this image and provide a title and detailed description.".to_string()
        });

        let request = GenerateContentRequest {
            contents: vec![Content {
                parts: vec![
                    Part {
                        text: Some(prompt),
                        inline_data: None,
                    },
                    Part {
                        text: None,
                        inline_data: Some(InlineData {
                            mime_type: image_data.0,
                            data: image_data.1,
                        }),
                    },
                ],
                role: None,
            }],
            generation_config: Some(GenerationConfig {
                temperature: Some(0.7),
                top_k: None,
                top_p: None,
                max_output_tokens: Some(8192),
                stop_sequences: None,
                response_mime_type: None,
            }),
            safety_settings: None,
            system_instruction: None,
        };

        let response: GenerateContentResponse = self.send_request(&url, &request).await?;
        let text = response.get_text();

        if let Ok(json_response) = serde_json::from_str::<ImageDescriptionResponse>(&text) {
            return Ok(json_response);
        }

        let title_regex = regex::Regex::new(r"(?i)title[:\s]+(.+?)(?:\n|$)").unwrap();
        let title = title_regex
            .captures(&text)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_else(|| "Image Analysis".to_string());

        let description = title_regex.replace(&text, "").trim().to_string();

        Ok(ImageDescriptionResponse {
            title,
            description: if description.is_empty() {
                text
            } else {
                description
            },
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
        model: &Model,
    ) -> Result<ObjectGenerationResponse> {
        debug!(model = %model, "Generating JSON object");

        let url = self.config.generate_content_url(model);

        let mut prompt = params.prompt.clone();
        if let Some(schema) = &params.schema {
            prompt.push_str(&format!(
                "\n\nPlease respond with a JSON object that follows this schema:\n{}",
                serde_json::to_string_pretty(schema).unwrap_or_default()
            ));
        }

        let system = format!(
            "{}{}",
            params.system.as_deref().unwrap_or(""),
            "\nYou must respond with valid JSON only. No markdown, no code blocks, no explanation text."
        );

        let request = GenerateContentRequest {
            contents: vec![Content {
                parts: vec![Part {
                    text: Some(prompt),
                    inline_data: None,
                }],
                role: None,
            }],
            generation_config: Some(GenerationConfig {
                temperature: params.temperature,
                top_k: None,
                top_p: None,
                max_output_tokens: Some(params.max_tokens.unwrap_or(model.default_max_tokens())),
                stop_sequences: None,
                response_mime_type: Some("application/json".to_string()),
            }),
            safety_settings: None,
            system_instruction: Some(Content {
                parts: vec![Part {
                    text: Some(system.trim().to_string()),
                    inline_data: None,
                }],
                role: None,
            }),
        };

        let response: GenerateContentResponse = self.send_request(&url, &request).await?;
        let text = response.get_text();
        let usage = response.usage_metadata.unwrap_or_default();

        let object = self.extract_json(&text)?;

        Ok(ObjectGenerationResponse {
            object,
            usage,
            model: model.id().to_string(),
        })
    }

    async fn send_request<T: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        request: &T,
    ) -> Result<R> {
        let response = self.http_client.post(url).json(request).send().await?;

        let status = response.status();

        if status.is_success() {
            let body = response.json::<R>().await?;
            Ok(body)
        } else {
            let error_body = response.text().await.unwrap_or_default();

            if let Ok(error_response) = serde_json::from_str::<ErrorResponse>(&error_body) {
                if status.as_u16() == 429 {
                    return Err(GoogleGenAIError::RateLimitError {
                        retry_after_seconds: 60,
                    });
                }

                return Err(GoogleGenAIError::ApiError {
                    error_type: error_response.error.status,
                    message: error_response.error.message,
                });
            }

            Err(GoogleGenAIError::http(
                format!("API request failed: {} - {}", status, error_body),
                Some(status.as_u16()),
            ))
        }
    }

    async fn fetch_image(&self, url: &str) -> Result<(String, String)> {
        let response =
            self.http_client
                .get(url)
                .send()
                .await
                .map_err(|e| GoogleGenAIError::NetworkError {
                    message: format!("Failed to fetch image: {}", e),
                })?;

        if !response.status().is_success() {
            return Err(GoogleGenAIError::NetworkError {
                message: format!("Failed to fetch image: {}", response.status()),
            });
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_string();

        let bytes = response
            .bytes()
            .await
            .map_err(|e| GoogleGenAIError::NetworkError {
                message: format!("Failed to read image bytes: {}", e),
            })?;

        let base64_data = base64::engine::general_purpose::STANDARD.encode(&bytes);

        Ok((content_type, base64_data))
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
        Err(GoogleGenAIError::json_generation(
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

    fn test_config() -> GoogleGenAIConfig {
        GoogleGenAIConfig::new("test-api-key").unwrap()
    }

    #[test]
    fn test_client_creation() {
        let client = GoogleGenAIClient::new(test_config());
        assert!(client.is_ok());
    }

    #[test]
    fn test_extract_json_direct() {
        let client = GoogleGenAIClient::new(test_config()).unwrap();
        let result = client.extract_json(r#"{"message": "hello"}"#);
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }

    #[test]
    fn test_extract_json_code_block() {
        let client = GoogleGenAIClient::new(test_config()).unwrap();
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
        let client = GoogleGenAIClient::new(test_config()).unwrap();
        let result = client.extract_json(r#"The result is {"message": "hello"} as requested."#);
        assert!(result.is_ok());
        assert_eq!(result.unwrap()["message"], "hello");
    }
}
