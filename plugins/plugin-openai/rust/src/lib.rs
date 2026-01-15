//! OpenAI model provider plugin for ElizaOS.
//!
//! This crate provides:
//! - A typed OpenAI HTTP client (`OpenAIClient`)
//! - Convenience wrappers (`OpenAIPlugin`)
//! - A helper to construct an ElizaOS plugin definition
#![warn(missing_docs)]

/// Audio helpers and endpoints.
pub mod audio;
/// OpenAI API client implementation.
pub mod client;
/// Error types and result aliases.
pub mod error;
/// Tokenization helpers.
pub mod tokenization;
/// Typed request/response models.
pub mod types;

pub use audio::{detect_audio_mime_type, get_filename_for_data, AudioMimeType};
pub use client::OpenAIClient;
pub use error::{OpenAIError, Result};
pub use tokenization::{count_tokens, detokenize, tokenize, truncate_to_token_limit};
pub use types::{
    ChatCompletionChoice, ChatCompletionResponse, ChatMessage, EmbeddingData, EmbeddingParams,
    EmbeddingResponse, ImageData, ImageDescriptionParams, ImageDescriptionResult,
    ImageGenerationParams, ImageGenerationResponse, ImageGenerationResult, ImageQuality, ImageSize,
    ImageStyle, ModelInfo, ModelsResponse, OpenAIConfig, ResearchAnnotation, ResearchParams,
    ResearchResult, ResponsesApiError, ResponsesApiResponse, TTSOutputFormat, TTSVoice,
    TextGenerationParams, TextToSpeechParams, TranscriptionParams, TranscriptionResponse,
    TranscriptionResponseFormat,
};

use anyhow::Result as AnyhowResult;
use std::sync::Arc;

/// High-level OpenAI plugin wrapper around an [`OpenAIClient`].
pub struct OpenAIPlugin {
    client: OpenAIClient,
}

impl OpenAIPlugin {
    /// Create a new [`OpenAIPlugin`] from an [`OpenAIConfig`].
    pub fn new(config: OpenAIConfig) -> Result<Self> {
        let client = OpenAIClient::new(config)?;
        Ok(Self { client })
    }

    /// Generate text from a user prompt using the default parameters.
    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        self.client.generate_text(&params).await
    }

    /// Generate text from a user prompt with a system message.
    pub async fn generate_text_with_system(&self, prompt: &str, system: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt).system(system);
        self.client.generate_text(&params).await
    }

    /// Generate text from explicitly provided generation parameters.
    pub async fn generate_text_with_params(&self, params: &TextGenerationParams) -> Result<String> {
        self.client.generate_text(params).await
    }

    /// Create an embedding vector for the provided text.
    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.client.create_embedding(&params).await
    }

    /// Get a reference to the underlying [`OpenAIClient`].
    pub fn client(&self) -> &OpenAIClient {
        &self.client
    }
}

/// Construct an [`OpenAIPlugin`] from environment variables.
///
/// Required:
/// - `OPENAI_API_KEY`
///
/// Optional:
/// - `OPENAI_BASE_URL`
/// - `OPENAI_SMALL_MODEL`
/// - `OPENAI_LARGE_MODEL`
pub fn get_openai_plugin() -> AnyhowResult<OpenAIPlugin> {
    let api_key = std::env::var("OPENAI_API_KEY")
        .map_err(|_| anyhow::anyhow!("OPENAI_API_KEY environment variable is required"))?;

    let mut config = OpenAIConfig::new(&api_key);

    if let Ok(base_url) = std::env::var("OPENAI_BASE_URL") {
        config = config.base_url(&base_url);
    }

    if let Ok(model) = std::env::var("OPENAI_SMALL_MODEL") {
        config = config.small_model(&model);
    }

    if let Ok(model) = std::env::var("OPENAI_LARGE_MODEL") {
        config = config.large_model(&model);
    }

    if let Ok(model) = std::env::var("OPENAI_RESEARCH_MODEL") {
        config = config.research_model(&model);
    }

    if let Ok(timeout) = std::env::var("OPENAI_RESEARCH_TIMEOUT") {
        if let Ok(timeout_secs) = timeout.parse::<u64>() {
            config = config.research_timeout_secs(timeout_secs);
        }
    }

    OpenAIPlugin::new(config).map_err(|e| anyhow::anyhow!("Failed to create OpenAI plugin: {}", e))
}

/// Create an ElizaOS [`elizaos::types::Plugin`] wired to OpenAI model handlers.
pub fn create_openai_elizaos_plugin() -> AnyhowResult<elizaos::types::Plugin> {
    use elizaos::types::{Plugin, PluginDefinition};
    use std::collections::HashMap;

    let openai = Arc::new(get_openai_plugin()?);

    let mut model_handlers: HashMap<String, elizaos::types::ModelHandlerFn> = HashMap::new();

    let openai_large = openai.clone();
    model_handlers.insert(
        "TEXT_LARGE".to_string(),
        Box::new(move |params: serde_json::Value| {
            let openai = openai_large.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                let system = params.get("system").and_then(|v| v.as_str());
                let temperature = params
                    .get("temperature")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.7) as f32;

                let mut text_params = TextGenerationParams::new(prompt).temperature(temperature);

                if let Some(sys) = system {
                    text_params = text_params.system(sys);
                }

                openai
                    .generate_text_with_params(&text_params)
                    .await
                    .map_err(|e| anyhow::anyhow!("OpenAI error: {}", e))
            })
        }),
    );

    let openai_small = openai.clone();
    model_handlers.insert(
        "TEXT_SMALL".to_string(),
        Box::new(move |params: serde_json::Value| {
            let openai = openai_small.clone();
            Box::pin(async move {
                let prompt = params.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
                let system = params.get("system").and_then(|v| v.as_str());
                let temperature = params
                    .get("temperature")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.7) as f32;

                let mut text_params = TextGenerationParams::new(prompt).temperature(temperature);

                if let Some(sys) = system {
                    text_params = text_params.system(sys);
                }

                openai
                    .generate_text_with_params(&text_params)
                    .await
                    .map_err(|e| anyhow::anyhow!("OpenAI error: {}", e))
            })
        }),
    );

    let openai_research = openai.clone();
    model_handlers.insert(
        "RESEARCH".to_string(),
        Box::new(move |params: serde_json::Value| {
            let openai = openai_research.clone();
            Box::pin(async move {
                let input = params.get("input").and_then(|v| v.as_str()).unwrap_or("");
                let instructions = params.get("instructions").and_then(|v| v.as_str());
                let background = params.get("background").and_then(|v| v.as_bool());
                let tools = params.get("tools").and_then(|v| v.as_array()).cloned();
                let max_tool_calls = params.get("maxToolCalls").and_then(|v| v.as_i64()).map(|v| v as i32);
                let model = params.get("model").and_then(|v| v.as_str());

                let mut research_params = ResearchParams::new(input);

                if let Some(inst) = instructions {
                    research_params = research_params.instructions(inst);
                }
                if let Some(bg) = background {
                    research_params = research_params.background(bg);
                }
                if let Some(t) = tools {
                    research_params = research_params.tools(t);
                }
                if let Some(max) = max_tool_calls {
                    research_params = research_params.max_tool_calls(max);
                }
                if let Some(m) = model {
                    research_params = research_params.model(m);
                }

                let result = openai
                    .client()
                    .deep_research(&research_params)
                    .await
                    .map_err(|e| anyhow::anyhow!("OpenAI error: {}", e))?;

                // Convert result to JSON string
                let result_json = serde_json::json!({
                    "id": result.id,
                    "text": result.text,
                    "annotations": result.annotations.iter().map(|a| serde_json::json!({
                        "url": a.url,
                        "title": a.title,
                        "startIndex": a.start_index,
                        "endIndex": a.end_index,
                    })).collect::<Vec<_>>(),
                    "outputItems": result.output_items,
                    "status": result.status,
                });

                Ok(serde_json::to_string(&result_json).unwrap_or_default())
            })
        }),
    );

    Ok(Plugin {
        definition: PluginDefinition {
            name: "openai".to_string(),
            description: "OpenAI model provider for elizaOS".to_string(),
            ..Default::default()
        },
        model_handlers,
        ..Default::default()
    })
}
