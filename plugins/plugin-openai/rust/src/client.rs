#![allow(missing_docs)]

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
    ImageDescriptionParams, ImageDescriptionResult, ImageGenerationParams, ImageGenerationResponse,
    ImageGenerationResult, ModelsResponse, OpenAIConfig, ResearchAnnotation, ResearchParams,
    ResearchResult, ResponsesApiResponse, TextGenerationParams, TextToSpeechParams,
    TranscriptionParams, TranscriptionResponse,
};

pub struct OpenAIClient {
    client: Client,
    config: OpenAIConfig,
}

impl OpenAIClient {
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

        // Try to parse as JSON error
        let message = serde_json::from_str::<serde_json::Value>(&message)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(message);

        Err(OpenAIError::ApiError { status, message })
    }

    pub async fn list_models(&self) -> Result<ModelsResponse> {
        debug!("Listing OpenAI models");
        let response = self.client.get(self.url("/models")).send().await?;
        let response = self.check_response(response).await?;
        Ok(response.json().await?)
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
            .ok_or(OpenAIError::EmptyResponse)
    }

    fn model_supports_temperature(model: &str) -> bool {
        let model_lower = model.to_lowercase();
        !model_lower.contains("gpt-5") && !model_lower.contains("o1") && !model_lower.contains("o3")
    }

    pub async fn generate_text(&self, params: &TextGenerationParams) -> Result<String> {
        let model = params.model.as_deref().unwrap_or(&self.config.large_model);
        debug!("Generating text with model: {}", model);

        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(system) = &params.system {
            let system_content: String = system.clone();
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: Some(system_content),
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
            .ok_or(OpenAIError::EmptyResponse)
    }

    pub async fn stream_text(
        &self,
        params: &TextGenerationParams,
    ) -> Result<impl futures::Stream<Item = Result<String>>> {
        let model = params.model.as_deref().unwrap_or(&self.config.large_model);
        debug!("Streaming text with model: {}", model);

        let mut messages: Vec<ChatMessage> = Vec::new();
        if let Some(system) = &params.system {
            let system_content: String = system.clone();
            messages.push(ChatMessage {
                role: "system".to_string(),
                content: Some(system_content),
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

        if Self::model_supports_temperature(model) {
            if let Some(temp) = params.temperature {
                body["temperature"] = serde_json::json!(temp);
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

        let mut body = serde_json::json!({
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": params.image_url}}
                ]
            }]
        });
        if Self::model_supports_temperature(model) {
            body["max_tokens"] = serde_json::json!(max_tokens);
        } else {
            body["max_completion_tokens"] = serde_json::json!(max_tokens);
        }

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

    fn get_audio_mime_type(filename: &str) -> &'static str {
        let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
        match ext.as_str() {
            "mp3" | "mpga" | "mpeg" => "audio/mpeg",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "m4a" | "mp4" => "audio/mp4",
            "ogg" | "oga" => "audio/ogg",
            "webm" => "audio/webm",
            _ => "audio/webm",
        }
    }

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

        let mut form = Form::new()
            .text("model", model.to_string())
            .part("file", part);

        if let Some(language) = &params.language {
            let lang_str: String = language.clone();
            form = form.text("language", lang_str);
        }
        if let Some(prompt) = &params.prompt {
            let prompt_str: String = prompt.clone();
            form = form.text("prompt", prompt_str);
        }
        if let Some(temp) = params.temperature {
            let temp_str: String = temp.to_string();
            form = form.text("temperature", temp_str);
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

        serde_json::from_str(cleaned).map_err(|e| OpenAIError::ParseError(e.to_string()))
    }

    /// Perform deep research using the Responses API.
    ///
    /// Deep research models can take tens of minutes to complete.
    /// Use background mode for long-running tasks.
    pub async fn deep_research(&self, params: &ResearchParams) -> Result<ResearchResult> {
        let model = params
            .model
            .as_deref()
            .unwrap_or(&self.config.research_model);
        debug!("Deep research with model: {}", model);

        let mut body = serde_json::json!({
            "model": model,
            "input": params.input,
        });

        if let Some(instructions) = &params.instructions {
            body["instructions"] = serde_json::json!(instructions);
        }

        if let Some(background) = params.background {
            body["background"] = serde_json::json!(background);
        }

        if let Some(tools) = &params.tools {
            body["tools"] = serde_json::json!(tools);
        } else {
            // Default to web search if no tools specified
            body["tools"] = serde_json::json!([{"type": "web_search_preview"}]);
        }

        if let Some(max_calls) = params.max_tool_calls {
            body["max_tool_calls"] = serde_json::json!(max_calls);
        }

        if let Some(summary) = &params.reasoning_summary {
            body["reasoning"] = serde_json::json!({ "summary": summary });
        }

        // Use longer timeout for research
        let research_client = Client::builder()
            .default_headers({
                let mut headers = HeaderMap::new();
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {}", self.config.api_key))
                        .map_err(|e| OpenAIError::ConfigError(e.to_string()))?,
                );
                headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                headers
            })
            .timeout(Duration::from_secs(self.config.research_timeout_secs))
            .build()?;

        let response = research_client
            .post(format!("{}/responses", self.config.base_url))
            .json(&body)
            .send()
            .await?;

        let response = self.check_response(response).await?;
        let api_response: ResponsesApiResponse = response.json().await?;

        if let Some(error) = api_response.error {
            return Err(OpenAIError::ApiError {
                status: 400,
                message: error.message,
            });
        }

        // Extract text and annotations from response
        let mut text = api_response.output_text.unwrap_or_default();
        let mut annotations: Vec<ResearchAnnotation> = Vec::new();

        for item in &api_response.output {
            if item.get("type").and_then(|v| v.as_str()) == Some("message") {
                if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                    for c in content {
                        if text.is_empty() {
                            if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                text = t.to_string();
                            }
                        }
                        if let Some(anns) = c.get("annotations").and_then(|v| v.as_array()) {
                            for ann in anns {
                                if let Ok(annotation) =
                                    serde_json::from_value::<ResearchAnnotation>(ann.clone())
                                {
                                    annotations.push(annotation);
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(ResearchResult {
            id: api_response.id,
            text,
            annotations,
            output_items: api_response.output,
            status: api_response.status,
        })
    }
}
