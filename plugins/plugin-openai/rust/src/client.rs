//! OpenAI API Client
//!
//! Async HTTP client for OpenAI API interactions using reqwest.

use bytes::Bytes;
use futures::StreamExt;
use regex::Regex;
use reqwest::{
    header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    multipart::{Form, Part},
    Client, Response,
};
use std::time::Duration;
use tracing::debug;

use crate::error::{OpenAIError, Result};
use crate::types::{
    ChatCompletionResponse, ChatMessage, EmbeddingParams, EmbeddingResponse,
    ImageDescriptionParams, ImageDescriptionResult, ImageGenerationParams,
    ImageGenerationResponse, ImageGenerationResult, ModelsResponse, OpenAIConfig,
    TextGenerationParams, TextToSpeechParams, TranscriptionParams, TranscriptionResponse,
};

/// OpenAI API client.
pub struct OpenAIClient {
    client: Client,
    config: OpenAIConfig,
}

impl OpenAIClient {
    /// Create a new OpenAI client.
    pub fn new(config: OpenAIConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.api_key))
                .map_err(|e| OpenAIError::ConfigError(e.to_string()))?,
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let client = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()?;

        Ok(Self { client, config })
    }

    /// Build URL for an endpoint.
    fn url(&self, endpoint: &str) -> String {
        format!("{}{}", self.config.base_url, endpoint)
    }

    /// Check response for errors.
    async fn check_response(&self, response: Response) -> Result<Response> {
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

        Err(OpenAIError::ApiError { status, message })
    }

    // =========================================================================
    // Models
    // =========================================================================

    /// List available models.
    pub async fn list_models(&self) -> Result<ModelsResponse> {
        debug!("Listing OpenAI models");
        let response = self.client.get(self.url("/models")).send().await?;
        let response = self.check_response(response).await?;
        Ok(response.json().await?)
    }

    // =========================================================================
    // Embeddings
    // =========================================================================

    /// Generate an embedding for text.
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
            .ok_or(OpenAIError::EmptyResponse)
    }

    // =========================================================================
    // Text Generation
    // =========================================================================

    /// Check if model supports temperature/sampling parameters.
    /// gpt-5 and gpt-5-mini (reasoning models) don't support these.
    fn model_supports_temperature(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        !model_lower.contains("gpt-5")
            && !model_lower.contains("o1")
            && !model_lower.contains("o3")
    }

    /// Generate text using chat completions.
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

        // Only add temperature/sampling params for models that support them
        // gpt-5, gpt-5-mini, o1, o3 models don't support these
        if Self::model_supports_temperature(model) {
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
            // Reasoning models (gpt-5, o1, o3) use max_completion_tokens instead of max_tokens
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

        let completion: ChatCompletionResponse = response.json().await?;
        completion
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .ok_or(OpenAIError::EmptyResponse)
    }

    /// Stream text generation.
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
            "stream": true,
        });

        // Only add temperature for models that support it
        // gpt-5 models use max_completion_tokens instead of max_tokens
        if Self::model_supports_temperature(model) {
            if let Some(temp) = params.temperature {
                body["temperature"] = serde_json::json!(temp);
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
                Err(e) => Some(Err(OpenAIError::HttpError(e))),
            }
        });

        Ok(stream)
    }

    // =========================================================================
    // Image Generation
    // =========================================================================

    /// Generate images using DALL-E.
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

    // =========================================================================
    // Image Description
    // =========================================================================

    /// Describe/analyze an image using GPT-4 Vision.
    pub async fn describe_image(
        &self,
        params: &ImageDescriptionParams,
    ) -> Result<ImageDescriptionResult> {
        let model = params.model.as_deref().unwrap_or("gpt-5-mini");
        let prompt = params.prompt.as_deref().unwrap_or(
            "Please analyze this image and provide a title and detailed description.",
        );
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
            .ok_or(OpenAIError::EmptyResponse)?;

        // Parse title and description from response
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

    // =========================================================================
    // Audio Transcription
    // =========================================================================

    /// Get MIME type from filename extension.
    fn get_audio_mime_type(filename: &str) -> &'static str {
        let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
        match ext.as_str() {
            "mp3" | "mpga" | "mpeg" => "audio/mpeg",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "m4a" | "mp4" => "audio/mp4",
            "ogg" | "oga" => "audio/ogg",
            "webm" => "audio/webm",
            _ => "audio/webm", // Default fallback
        }
    }

    /// Transcribe audio using Whisper.
    pub async fn transcribe_audio(
        &self,
        audio_data: Bytes,
        params: &TranscriptionParams,
        filename: &str,
    ) -> Result<String> {
        let model = params
            .model
            .as_deref()
            .unwrap_or(&self.config.transcription_model);
        debug!("Transcribing audio with model: {}", model);

        let mime_type = Self::get_audio_mime_type(filename);
        debug!("Using MIME type: {} for file: {}", mime_type, filename);

        let part = Part::bytes(audio_data.to_vec())
            .file_name(filename.to_string())
            .mime_str(mime_type)
            .map_err(|e| OpenAIError::ConfigError(e.to_string()))?;

        let mut form = Form::new().text("model", model.to_string()).part("file", part);

        if let Some(language) = &params.language {
            form = form.text("language", language.clone());
        }
        if let Some(prompt) = &params.prompt {
            form = form.text("prompt", prompt.clone());
        }
        if let Some(temp) = params.temperature {
            form = form.text("temperature", temp.to_string());
        }
        if let Some(format) = &params.response_format {
            form = form.text(
                "response_format",
                serde_json::to_string(format)?.trim_matches('"').to_string(),
            );
        }

        let response = self
            .client
            .post(self.url("/audio/transcriptions"))
            .multipart(form)
            .send()
            .await?;
        let response = self.check_response(response).await?;

        let transcription: TranscriptionResponse = response.json().await?;
        Ok(transcription.text)
    }

    // =========================================================================
    // Text-to-Speech
    // =========================================================================

    /// Convert text to speech.
    pub async fn text_to_speech(&self, params: &TextToSpeechParams) -> Result<Bytes> {
        let model = params.model.as_deref().unwrap_or(&self.config.tts_model);
        let voice = params.voice.unwrap_or(self.config.tts_voice);
        debug!("Text-to-speech with model: {}", model);

        let mut body = serde_json::json!({
            "model": model,
            "input": params.text,
            "voice": voice,
        });

        if let Some(format) = &params.response_format {
            body["response_format"] = serde_json::to_value(format)?;
        }
        if let Some(speed) = params.speed {
            body["speed"] = serde_json::json!(speed);
        }

        let response = self
            .client
            .post(self.url("/audio/speech"))
            .json(&body)
            .send()
            .await?;
        let response = self.check_response(response).await?;

        Ok(response.bytes().await?)
    }

    // =========================================================================
    // Structured Output
    // =========================================================================

    /// Generate a structured JSON object.
    ///
    /// Convenience method that wraps `generate_text` with JSON-focused prompting.
    /// Note: gpt-5 models don't support temperature, so it's not passed.
    pub async fn generate_object(
        &self,
        prompt: &str,
        _temperature: Option<f32>,
    ) -> Result<serde_json::Value> {
        // Note: temperature is ignored for gpt-5 models (reasoning models)
        let params = TextGenerationParams::new(format!("Respond with only valid JSON. {}", prompt));

        let response = self.generate_text(&params).await?;

        // Clean up potential markdown code blocks
        let cleaned = response
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        serde_json::from_str(cleaned).map_err(|e| OpenAIError::ParseError(e.to_string()))
    }
}

