#![allow(missing_docs)]

use crate::error::{GroqError, GroqErrorCode};
use crate::types::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage, GenerateObjectParams,
    GenerateTextParams, GroqConfig, MessageRole, ModelInfo, ModelsResponse, TextToSpeechParams,
    TranscriptionParams, TranscriptionResponse,
};
use crate::DEFAULT_BASE_URL;
use reqwest::{header, multipart, Client};
use tracing::warn;

#[derive(Debug, Clone)]
pub struct GroqClient {
    client: Client,
    config: GroqConfig,
}

impl GroqClient {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Result<Self, GroqError> {
        let api_key = api_key.into();
        if api_key.is_empty() {
            return Err(GroqError::Config("API key is required".into()));
        }

        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_str(&format!("Bearer {}", api_key))
                .map_err(|e| GroqError::Config(format!("Invalid API key: {}", e)))?,
        );
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );

        let client = Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| GroqError::Config(format!("Failed to create client: {}", e)))?;

        let config = GroqConfig {
            api_key,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            ..Default::default()
        };

        Ok(Self { client, config })
    }

    pub fn with_config(config: GroqConfig) -> Result<Self, GroqError> {
        if config.api_key.is_empty() {
            return Err(GroqError::Config("API key is required".into()));
        }

        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_str(&format!("Bearer {}", config.api_key))
                .map_err(|e| GroqError::Config(format!("Invalid API key: {}", e)))?,
        );
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );

        let client = Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| GroqError::Config(format!("Failed to create client: {}", e)))?;

        Ok(Self { client, config })
    }

    pub async fn generate_text_small(
        &self,
        params: GenerateTextParams,
    ) -> Result<String, GroqError> {
        self.generate_text(&self.config.small_model, params).await
    }

    pub async fn generate_text_large(
        &self,
        params: GenerateTextParams,
    ) -> Result<String, GroqError> {
        self.generate_text(&self.config.large_model, params).await
    }

    async fn generate_text(
        &self,
        model: &str,
        params: GenerateTextParams,
    ) -> Result<String, GroqError> {
        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(ref system_str) = params.system {
            messages.push(ChatMessage {
                role: MessageRole::System,
                content: system_str.clone(),
            });
        }
        messages.push(ChatMessage {
            role: MessageRole::User,
            content: params.prompt,
        });

        let request = ChatCompletionRequest {
            model: model.to_string(),
            messages,
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            frequency_penalty: params.frequency_penalty,
            presence_penalty: params.presence_penalty,
            stop: if params.stop.is_empty() {
                None
            } else {
                Some(params.stop)
            },
        };

        let response = self
            .client
            .post(format!("{}/chat/completions", self.config.base_url))
            .json(&request)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            return Err(
                self.handle_error(status.as_u16(), &response.text().await.unwrap_or_default())
            );
        }

        let completion: ChatCompletionResponse = response.json().await?;
        completion
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| GroqError::Request {
                message: "No choices returned".into(),
                status_code: 200,
                code: GroqErrorCode::InvalidRequest,
            })
    }

    pub async fn generate_object_small(
        &self,
        params: GenerateObjectParams,
    ) -> Result<serde_json::Value, GroqError> {
        self.generate_object_with_model(&self.config.small_model, params)
            .await
    }

    pub async fn generate_object_large(
        &self,
        params: GenerateObjectParams,
    ) -> Result<serde_json::Value, GroqError> {
        self.generate_object_with_model(&self.config.large_model, params)
            .await
    }

    pub async fn generate_object(
        &self,
        params: GenerateObjectParams,
    ) -> Result<serde_json::Value, GroqError> {
        self.generate_object_large(params).await
    }

    async fn generate_object_with_model(
        &self,
        model: &str,
        params: GenerateObjectParams,
    ) -> Result<serde_json::Value, GroqError> {
        let text = self
            .generate_text(
                model,
                GenerateTextParams {
                    prompt: params.prompt,
                    temperature: params.temperature,
                    ..Default::default()
                },
            )
            .await?;

        let json_str = extract_json(&text);
        serde_json::from_str(&json_str).map_err(GroqError::from)
    }

    pub async fn transcribe(&self, params: TranscriptionParams) -> Result<String, GroqError> {
        let file_part = multipart::Part::bytes(params.audio)
            .file_name(format!("audio.{}", params.format))
            .mime_str(&format!("audio/{}", params.format))
            .map_err(|e| GroqError::Config(format!("Invalid audio format: {}", e)))?;

        let form = multipart::Form::new()
            .part("file", file_part)
            .text("model", self.config.transcription_model.clone());

        let response = self
            .client
            .post(format!("{}/audio/transcriptions", self.config.base_url))
            .multipart(form)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            return Err(
                self.handle_error(status.as_u16(), &response.text().await.unwrap_or_default())
            );
        }

        let result: TranscriptionResponse = response.json().await?;
        Ok(result.text)
    }

    pub async fn text_to_speech(&self, params: TextToSpeechParams) -> Result<Vec<u8>, GroqError> {
        let voice = params
            .voice
            .unwrap_or_else(|| self.config.tts_voice.clone());

        let body = serde_json::json!({
            "model": self.config.tts_model,
            "voice": voice,
            "input": params.text,
        });

        let response = self
            .client
            .post(format!("{}/audio/speech", self.config.base_url))
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            return Err(
                self.handle_error(status.as_u16(), &response.text().await.unwrap_or_default())
            );
        }

        Ok(response.bytes().await?.to_vec())
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, GroqError> {
        let response = self
            .client
            .get(format!("{}/models", self.config.base_url))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            return Err(
                self.handle_error(status.as_u16(), &response.text().await.unwrap_or_default())
            );
        }

        let models: ModelsResponse = response.json().await?;
        Ok(models.data)
    }

    fn handle_error(&self, status: u16, body: &str) -> GroqError {
        match status {
            401 => GroqError::Authentication {
                message: "Invalid API key".into(),
                code: GroqErrorCode::InvalidApiKey,
            },
            429 => {
                let retry_after = extract_retry_delay(body);
                warn!("Rate limited, retry after {:?}s", retry_after);
                GroqError::RateLimit {
                    retry_after,
                    code: GroqErrorCode::RateLimitExceeded,
                }
            }
            _ => GroqError::Request {
                message: body.to_string(),
                status_code: status,
                code: if status >= 500 {
                    GroqErrorCode::ServerError
                } else {
                    GroqErrorCode::InvalidRequest
                },
            },
        }
    }

    pub fn config(&self) -> &GroqConfig {
        &self.config
    }
}

fn extract_json(text: &str) -> String {
    if let Some(start) = text.find("```json") {
        if let Some(end) = text[start + 7..].find("```") {
            return text[start + 7..start + 7 + end].trim().to_string();
        }
    }
    if let Some(start) = text.find("```") {
        let after = &text[start + 3..];
        let content_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        if let Some(end) = after[content_start..].find("```") {
            return after[content_start..content_start + end].trim().to_string();
        }
    }
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            return text[start..=end].to_string();
        }
    }
    if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            return text[start..=end].to_string();
        }
    }
    text.to_string()
}

fn extract_retry_delay(message: &str) -> Option<f64> {
    let re = regex::Regex::new(r"try again in (\d+\.?\d*)s").ok()?;
    re.captures(message)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_json() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(extract_json("Here is {\"a\":1} the json"), "{\"a\":1}");
    }

    #[test]
    fn test_extract_retry_delay() {
        assert_eq!(extract_retry_delay("try again in 2.5s"), Some(2.5));
        assert_eq!(extract_retry_delay("no delay"), None);
    }
}
