//! OpenAI plugin for elizaOS providing text generation and embedding capabilities.
//!
//! This crate provides integration with OpenAI's API, including support for:
//! - Text generation (GPT models)
//! - Embeddings
//! - Audio transcription and generation
//!
//! # Example
//!
//! ```no_run
//! use elizaos_plugin_openai::{OpenAIPlugin, OpenAIConfig};
//!
//! let config = OpenAIConfig::new("your-api-key");
//! let plugin = OpenAIPlugin::new(config).unwrap();
//! ```

#![warn(missing_docs)]

pub mod audio;
pub mod client;
pub mod error;
pub mod tokenization;
pub mod types;

pub use audio::{detect_audio_mime_type, get_filename_for_data, AudioMimeType};
pub use client::OpenAIClient;
pub use error::{OpenAIError, Result};
pub use tokenization::{count_tokens, detokenize, tokenize, truncate_to_token_limit};
pub use types::*;

use anyhow::Result as AnyhowResult;
use std::sync::Arc;

/// High-level OpenAI plugin providing simplified access to OpenAI's API.
///
/// This struct wraps an [`OpenAIClient`] and provides convenient methods
/// for common operations like text generation and embedding creation.
pub struct OpenAIPlugin {
    client: OpenAIClient,
}

impl OpenAIPlugin {
    /// Creates a new OpenAI plugin with the given configuration.
    ///
    /// # Arguments
    ///
    /// * `config` - The OpenAI configuration containing API key and optional settings
    ///
    /// # Errors
    ///
    /// Returns an error if the client initialization fails.
    pub fn new(config: OpenAIConfig) -> Result<Self> {
        let client = OpenAIClient::new(config)?;
        Ok(Self { client })
    }

    /// Generates text from a prompt using default parameters.
    ///
    /// # Arguments
    ///
    /// * `prompt` - The input prompt for text generation
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails.
    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        self.client.generate_text(&params).await
    }

    /// Generates text from a prompt with a system message.
    ///
    /// # Arguments
    ///
    /// * `prompt` - The input prompt for text generation
    /// * `system` - The system message to set context for the model
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails.
    pub async fn generate_text_with_system(&self, prompt: &str, system: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt).system(system);
        self.client.generate_text(&params).await
    }

    /// Generates text using fully customizable parameters.
    ///
    /// # Arguments
    ///
    /// * `params` - The text generation parameters including prompt, temperature, etc.
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails.
    pub async fn generate_text_with_params(&self, params: &TextGenerationParams) -> Result<String> {
        self.client.generate_text(params).await
    }

    /// Creates an embedding vector for the given text.
    ///
    /// # Arguments
    ///
    /// * `text` - The text to create an embedding for
    ///
    /// # Errors
    ///
    /// Returns an error if the API request fails.
    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.client.create_embedding(&params).await
    }

    /// Returns a reference to the underlying OpenAI client.
    ///
    /// Use this for advanced operations not covered by the high-level methods.
    pub fn client(&self) -> &OpenAIClient {
        &self.client
    }
}

/// Creates an OpenAI plugin configured from environment variables.
///
/// # Environment Variables
///
/// * `OPENAI_API_KEY` (required) - Your OpenAI API key
/// * `OPENAI_BASE_URL` (optional) - Custom base URL for API requests
/// * `OPENAI_SMALL_MODEL` (optional) - Model to use for small/fast operations
/// * `OPENAI_LARGE_MODEL` (optional) - Model to use for large/complex operations
///
/// # Errors
///
/// Returns an error if:
/// - `OPENAI_API_KEY` environment variable is not set
/// - Plugin initialization fails
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

    OpenAIPlugin::new(config).map_err(|e| anyhow::anyhow!("Failed to create OpenAI plugin: {}", e))
}

/// Creates an elizaOS-compatible plugin instance for OpenAI.
///
/// This function creates a fully configured [`elizaos::types::Plugin`] that can be
/// registered with the elizaOS runtime. It provides model handlers for both
/// `TEXT_LARGE` and `TEXT_SMALL` model types.
///
/// # Model Handlers
///
/// * `TEXT_LARGE` - Uses the configured large model for complex text generation
/// * `TEXT_SMALL` - Uses the configured small model for fast text generation
///
/// Both handlers accept JSON parameters with the following fields:
/// - `prompt` (string) - The input prompt
/// - `system` (string, optional) - System message for context
/// - `temperature` (number, optional) - Sampling temperature (default: 0.7)
///
/// # Errors
///
/// Returns an error if the OpenAI plugin cannot be initialized.
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
                let prompt = params.get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let system = params.get("system")
                    .and_then(|v| v.as_str());
                let temperature = params.get("temperature")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.7) as f32;
                
                let mut text_params = TextGenerationParams::new(prompt)
                    .temperature(temperature);
                
                if let Some(sys) = system {
                    text_params = text_params.system(sys);
                }
                
                openai.generate_text_with_params(&text_params)
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
                let prompt = params.get("prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let system = params.get("system")
                    .and_then(|v| v.as_str());
                let temperature = params.get("temperature")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.7) as f32;
                
                let mut text_params = TextGenerationParams::new(prompt)
                    .temperature(temperature);
                
                if let Some(sys) = system {
                    text_params = text_params.system(sys);
                }
                
                openai.generate_text_with_params(&text_params)
                    .await
                    .map_err(|e| anyhow::anyhow!("OpenAI error: {}", e))
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
