#![allow(missing_docs)]

use futures::StreamExt;
use regex::Regex;
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    Client, Response,
};
use std::time::Duration;
use tracing::debug;

use crate::config::model_supports_temperature;
use crate::error::{GatewayError, Result};
use crate::types::{
    ChatCompletionResponse, ChatMessage, EmbeddingParams, EmbeddingResponse, GatewayConfig,
    ImageDescriptionParams, ImageDescriptionResult, ImageGenerationParams, ImageGenerationResponse,
    ImageGenerationResult, TextGenerationParams,
};

pub struct GatewayClient {
    client: Client,
    config: GatewayConfig,
}

impl GatewayClient {
    pub fn new(config: GatewayConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.api_key))
                .map_err(|e| GatewayError::ConfigError(e.to_string()))?,
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

    async fn check_response(&self, response: Response) -> Result<Response> {
        if response.status().is_success() {
            return Ok(response);
        }

        let status = response.status().as_u16();
        let message = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".to_string());

        let message = serde_json::from_str::<serde_json::Value>(&message)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(message);

        Err(GatewayError::ApiError { status, message })
    }

    pub async fn generate_text(&self, params: &TextGenerationParams) -> Result<String> {
        let model = params.model.as_deref().unwrap_or(&self.config.large_model);
        debug!("Generating text with model: {}", model);

        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(system) = &params.system {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: Some(system.clone()),
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: Some(params.prompt.clone()),
        });

        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
        });

        if model_supports_temperature(model) {
            if let Some(temp) = params.temperature {
                body["temperature"] = serde_json::json!(temp);
            }
            if let Some(fp) = params.frequency_penalty {
                body["frequency_penalty"] = serde_json::json!(fp);
            }
            if let Some(pp) = params.presence_penalty {
                body["presence_penalty"] = serde_json::json!(pp);
            }
            if let Some(stop) = &params.stop {
                body["stop"] = serde_json::json!(stop);
            }
            if let Some(max) = params.max_tokens {
                body["max_tokens"] = serde_json::json!(max);
            }
        } else if let Some(max) = params.max_tokens {
            body["max_completion_tokens"] = serde_json::json!(max);
        }

        let response = self
            .client
            .post(self.url("/chat/completions"))
            .json(&body)
            .send()
            .await?;
        let response = self.check_response(response).await?;

        let completion: ChatCompletionResponse = response.json().await?;
        completion
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or(GatewayError::EmptyResponse)
    }

    pub async fn stream_text(
        &self,
        params: &TextGenerationParams,
    ) -> Result<impl futures::Stream<Item = Result<String>>> {
        let model = params.model.as_deref().unwrap_or(&self.config.large_model);
        debug!("Streaming text with model: {}", model);

        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(system) = &params.system {
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: Some(system.to_string()),
            });
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: Some(params.prompt.clone()),
        });

        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": true,
        });

        if model_supports_temperature(model) {
            if let Some(temp) = params.temperature {
                body["temperature"] = serde_json::json!(temp);
            }
            if let Some(fp) = params.frequency_penalty {
                body["frequency_penalty"] = serde_json::json!(fp);
            }
            if let Some(pp) = params.presence_penalty {
                body["presence_penalty"] = serde_json::json!(pp);
            }
            if let Some(stop) = &params.stop {
                body["stop"] = serde_json::json!(stop);
            }
            if let Some(max) = params.max_tokens {
                body["max_tokens"] = serde_json::json!(max);
            }
        } else {
            // Reasoning models use max_completion_tokens
            if let Some(max) = params.max_tokens {
                body["max_completion_tokens"] = serde_json::json!(max);
            }
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
                Err(e) => Some(Err(GatewayError::HttpError(e))),
            }
        });

        Ok(stream)
    }

    pub async fn create_embedding(&self, params: &EmbeddingParams) -> Result<Vec<f32>> {
        let model = params
            .model
            .as_deref()
            .unwrap_or(&self.config.embedding_model);
        debug!("Creating embedding with model: {}", model);

        let mut body = serde_json::json!({
            "model": model,
            "input": params.text,
        });

        if let Some(dims) = params.dimensions {
            body["dimensions"] = serde_json::json!(dims);
        }

        let response = self
            .client
            .post(self.url("/embeddings"))
            .json(&body)
            .send()
            .await?;
        let response = self.check_response(response).await?;

        let embedding_response: EmbeddingResponse = response.json().await?;
        embedding_response
            .data
            .first()
            .map(|d| d.embedding.clone())
            .ok_or(GatewayError::EmptyResponse)
    }

    pub async fn generate_image(
        &self,
        params: &ImageGenerationParams,
    ) -> Result<Vec<ImageGenerationResult>> {
        let model = params.model.as_deref().unwrap_or(&self.config.image_model);
        debug!("Generating image with model: {}", model);

        let mut body = serde_json::json!({
            "model": model,
            "prompt": params.prompt,
        });

        if let Some(n) = params.n {
            body["n"] = serde_json::json!(n);
        }
        if let Some(size) = &params.size {
            body["size"] = serde_json::to_value(size)?;
        }
        if let Some(quality) = &params.quality {
            body["quality"] = serde_json::to_value(quality)?;
        }
        if let Some(style) = &params.style {
            body["style"] = serde_json::to_value(style)?;
        }

        let response = self
            .client
            .post(self.url("/images/generations"))
            .json(&body)
            .send()
            .await?;
        let response = self.check_response(response).await?;

        let image_response: ImageGenerationResponse = response.json().await?;
        Ok(image_response
            .data
            .into_iter()
            .map(|d| ImageGenerationResult {
                url: d.url,
                revised_prompt: d.revised_prompt,
            })
            .collect())
    }

    pub async fn describe_image(
        &self,
        params: &ImageDescriptionParams,
    ) -> Result<ImageDescriptionResult> {
        let model = params.model.as_deref().unwrap_or("gpt-5-mini");
        let prompt = params
            .prompt
            .as_deref()
            .unwrap_or("Please analyze this image and provide a title and detailed description.");
        let max_tokens = params.max_tokens.unwrap_or(8192);

        debug!("Describing image with model: {}", model);

        let body = serde_json::json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": params.image_url}}
                ]
            }],
            "max_tokens": max_tokens
        });

        let response = self
            .client
            .post(self.url("/chat/completions"))
            .json(&body)
            .send()
            .await?;
        let response = self.check_response(response).await?;

        let completion: ChatCompletionResponse = response.json().await?;
        let content = completion
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or(GatewayError::EmptyResponse)?;

        let title_regex = Regex::new(r"(?i)title[:\s]+(.+?)(?:\n|$)").ok();
        let title = title_regex
            .as_ref()
            .and_then(|re: &Regex| {
                re.captures(&content)
                    .and_then(|c: regex::Captures| c.get(1))
                    .map(|m: regex::Match| m.as_str().trim().to_string())
            })
            .unwrap_or_else(|| "Image Analysis".to_string());

        let description = title_regex
            .as_ref()
            .map(|re: &Regex| re.replace(&content, "").trim().to_string())
            .unwrap_or(content);

        Ok(ImageDescriptionResult { title, description })
    }

    pub async fn generate_object(
        &self,
        prompt: &str,
        _temperature: Option<f32>,
    ) -> Result<serde_json::Value> {
        let params = TextGenerationParams::new(format!("Respond with only valid JSON. {}", prompt));

        let response = self.generate_text(&params).await?;

        let cleaned = response
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        serde_json::from_str(cleaned).map_err(|e| GatewayError::ParseError(e.to_string()))
    }
}
