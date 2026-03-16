#![allow(missing_docs)]

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::error::{ElizaCloudError, Result};
use crate::types::{
    ElizaCloudConfig, ImageDescriptionParams, ImageDescriptionResult, ImageGenerationParams,
    TextEmbeddingParams, TextGenerationParams, TextToSpeechParams, TranscriptionParams,
};

#[derive(Debug, Clone)]
pub struct ElizaCloudClient {
    config: ElizaCloudConfig,
    client: Client,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<Message>,
    temperature: f32,
    max_tokens: u32,
    frequency_penalty: f32,
    presence_penalty: f32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    stop: Vec<String>,
    stream: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct Message {
    role: String,
    content: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: MessageContent,
}

#[derive(Debug, Deserialize)]
struct MessageContent {
    content: String,
}

#[derive(Debug, Serialize)]
struct EmbeddingRequest {
    model: String,
    input: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageGenerationRequest {
    prompt: String,
    num_images: u32,
    aspect_ratio: String,
    model: String,
}

#[derive(Debug, Deserialize)]
struct ImageGenerationResponse {
    images: Vec<ImageData>,
}

#[derive(Debug, Deserialize)]
struct ImageData {
    url: Option<String>,
    image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageResult {
    pub url: String,
}

#[derive(Debug, Serialize)]
struct TextToSpeechRequest {
    model: String,
    input: String,
    voice: String,
    #[serde(rename = "format")]
    response_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    instructions: Option<String>,
}

fn size_to_aspect_ratio(size: &str) -> &'static str {
    match size {
        "1024x1024" => "1:1",
        "1792x1024" => "16:9",
        "1024x1792" => "9:16",
        _ => "1:1",
    }
}

impl ElizaCloudClient {
    pub fn new(config: ElizaCloudConfig) -> Result<Self> {
        if config.api_key.is_empty() {
            return Err(ElizaCloudError::configuration("API key is required"));
        }

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(ElizaCloudError::Network)?;

        Ok(Self { config, client })
    }

    fn auth_headers(&self, use_embedding_key: bool) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        let api_key = if use_embedding_key {
            self.config
                .embedding_api_key
                .as_ref()
                .unwrap_or(&self.config.api_key)
        } else {
            &self.config.api_key
        };
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", api_key).parse().unwrap(),
        );
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        headers
    }

    fn get_url(&self, endpoint: &str, use_embedding_url: bool) -> String {
        let base = if use_embedding_url {
            self.config
                .embedding_url
                .as_ref()
                .unwrap_or(&self.config.base_url)
        } else {
            &self.config.base_url
        };
        format!("{}{}", base, endpoint)
    }

    pub async fn generate_text_small(&self, params: TextGenerationParams) -> Result<String> {
        self.generate_text(params, &self.config.small_model).await
    }

    pub async fn generate_text_large(&self, params: TextGenerationParams) -> Result<String> {
        self.generate_text(params, &self.config.large_model).await
    }

    async fn generate_text(&self, params: TextGenerationParams, model: &str) -> Result<String> {
        let request = ChatCompletionRequest {
            model: model.to_string(),
            messages: vec![Message {
                role: "user".to_string(),
                content: serde_json::Value::String(params.prompt),
            }],
            temperature: params.temperature,
            max_tokens: params.max_tokens,
            frequency_penalty: params.frequency_penalty,
            presence_penalty: params.presence_penalty,
            stop: params.stop_sequences,
            stream: false,
        };

        let response = self
            .client
            .post(self.get_url("/chat/completions", false))
            .headers(self.auth_headers(false))
            .json(&request)
            .send()
            .await?;

        self.handle_response::<ChatCompletionResponse>(response)
            .await
            .map(|r| {
                r.choices
                    .first()
                    .map(|c| c.message.content.clone())
                    .unwrap_or_default()
            })
    }

    pub async fn generate_embedding(&self, params: TextEmbeddingParams) -> Result<Vec<Vec<f32>>> {
        let input = if let Some(texts) = params.texts {
            texts
        } else if let Some(text) = params.text {
            vec![text]
        } else {
            return Err(ElizaCloudError::invalid_request(
                "Either text or texts must be provided",
                vec![],
            ));
        };

        let request = EmbeddingRequest {
            model: self.config.embedding_model.clone(),
            input,
        };

        let response = self
            .client
            .post(self.get_url("/embeddings", true))
            .headers(self.auth_headers(true))
            .json(&request)
            .send()
            .await?;

        self.handle_response::<EmbeddingResponse>(response)
            .await
            .map(|r| r.data.into_iter().map(|d| d.embedding).collect())
    }

    pub async fn generate_image(&self, params: ImageGenerationParams) -> Result<Vec<ImageResult>> {
        let aspect_ratio = size_to_aspect_ratio(&params.size);

        let request = ImageGenerationRequest {
            prompt: params.prompt,
            num_images: params.count,
            aspect_ratio: aspect_ratio.to_string(),
            model: self.config.image_generation_model.clone(),
        };

        let response = self
            .client
            .post(self.get_url("/generate-image", false))
            .headers(self.auth_headers(false))
            .json(&request)
            .send()
            .await?;

        let result = self
            .handle_response::<ImageGenerationResponse>(response)
            .await?;

        Ok(result
            .images
            .into_iter()
            .map(|img| ImageResult {
                url: img.url.or(img.image).unwrap_or_default(),
            })
            .collect())
    }

    pub async fn describe_image(
        &self,
        params: ImageDescriptionInput,
    ) -> Result<ImageDescriptionResult> {
        let (image_url, prompt_text) = match params {
            ImageDescriptionInput::Url(url) => (
                url,
                "Please analyze this image and provide a title and detailed description."
                    .to_string(),
            ),
            ImageDescriptionInput::Params(p) => (
                p.image_url,
                p.prompt.unwrap_or_else(|| {
                    "Please analyze this image and provide a title and detailed description."
                        .to_string()
                }),
            ),
        };

        let request = ChatCompletionRequest {
            model: self.config.image_description_model.clone(),
            messages: vec![Message {
                role: "user".to_string(),
                content: serde_json::json!([
                    {"type": "text", "text": prompt_text},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]),
            }],
            temperature: 0.7,
            max_tokens: self.config.image_description_max_tokens,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            stop: vec![],
            stream: false,
        };

        let response = self
            .client
            .post(self.get_url("/chat/completions", false))
            .headers(self.auth_headers(false))
            .json(&request)
            .send()
            .await?;

        let completion = self
            .handle_response::<ChatCompletionResponse>(response)
            .await?;
        let content = completion
            .choices
            .first()
            .map(|c| c.message.content.clone())
            .unwrap_or_default();

        let lines: Vec<&str> = content.trim().splitn(2, '\n').collect();
        let title = lines
            .first()
            .map(|s| s.replace("Title:", "").trim().to_string())
            .unwrap_or_else(|| "Untitled".to_string());
        let description = lines
            .get(1)
            .map(|s| s.trim().to_string())
            .unwrap_or(content);

        Ok(ImageDescriptionResult { title, description })
    }

    pub async fn generate_speech(&self, params: TextToSpeechParams) -> Result<Vec<u8>> {
        let model = params
            .model
            .unwrap_or_else(|| self.config.tts_model.clone());
        let voice = params
            .voice
            .unwrap_or_else(|| self.config.tts_voice.clone());
        let instructions = params
            .instructions
            .or_else(|| self.config.tts_instructions.clone());

        let request = TextToSpeechRequest {
            model,
            input: params.text,
            voice,
            response_format: params.format,
            instructions,
        };

        let response = self
            .client
            .post(self.get_url("/audio/speech", false))
            .headers(self.auth_headers(false))
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            return Err(ElizaCloudError::api(status, text));
        }

        Ok(response.bytes().await?.to_vec())
    }

    pub async fn transcribe_audio(&self, params: TranscriptionParams) -> Result<String> {
        let model = params
            .model
            .unwrap_or_else(|| self.config.transcription_model.clone());

        let form = reqwest::multipart::Form::new()
            .part(
                "file",
                reqwest::multipart::Part::bytes(params.audio)
                    .file_name("audio.wav")
                    .mime_str(&params.mime_type)?,
            )
            .text("model", model)
            .text("response_format", params.response_format);

        let form = if let Some(language) = params.language {
            form.text("language", language)
        } else {
            form
        };

        let form = if let Some(prompt) = params.prompt {
            form.text("prompt", prompt)
        } else {
            form
        };

        let form = if let Some(temp) = params.temperature {
            form.text("temperature", temp.to_string())
        } else {
            form
        };

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", self.config.api_key).parse().unwrap(),
        );

        let response = self
            .client
            .post(self.get_url("/audio/transcriptions", false))
            .headers(headers)
            .multipart(form)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            return Err(ElizaCloudError::api(status, text));
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        if content_type.contains("application/json") {
            let json: HashMap<String, serde_json::Value> = response.json().await?;
            Ok(json
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string())
        } else {
            Ok(response.text().await?)
        }
    }

    async fn handle_response<T: serde::de::DeserializeOwned>(
        &self,
        response: reqwest::Response,
    ) -> Result<T> {
        let status = response.status();

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ElizaCloudError::authentication("Invalid API key"));
        }

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse().ok());
            return Err(ElizaCloudError::rate_limit(
                "Rate limit exceeded",
                retry_after,
            ));
        }

        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(ElizaCloudError::api(status.as_u16(), text));
        }

        let body = response.text().await?;
        serde_json::from_str(&body).map_err(ElizaCloudError::Json)
    }
}

pub enum ImageDescriptionInput {
    Url(String),
    Params(ImageDescriptionParams),
}

impl From<String> for ImageDescriptionInput {
    fn from(url: String) -> Self {
        Self::Url(url)
    }
}

impl From<&str> for ImageDescriptionInput {
    fn from(url: &str) -> Self {
        Self::Url(url.to_string())
    }
}

impl From<ImageDescriptionParams> for ImageDescriptionInput {
    fn from(params: ImageDescriptionParams) -> Self {
        Self::Params(params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let config = ElizaCloudConfig::new("test_key");
        let client = ElizaCloudClient::new(config);
        assert!(client.is_ok());
    }

    #[test]
    fn test_client_empty_key() {
        let config = ElizaCloudConfig::new("");
        let client = ElizaCloudClient::new(config);
        assert!(client.is_err());
    }

    #[test]
    fn test_size_to_aspect_ratio() {
        assert_eq!(size_to_aspect_ratio("1024x1024"), "1:1");
        assert_eq!(size_to_aspect_ratio("1792x1024"), "16:9");
        assert_eq!(size_to_aspect_ratio("1024x1792"), "9:16");
        assert_eq!(size_to_aspect_ratio("unknown"), "1:1");
    }
}
