//! OpenAI Plugin for elizaOS
//!
//! This crate provides OpenAI API integration for elizaOS agents.
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_openai::get_openai_plugin;
//!
//! # async fn example() -> anyhow::Result<()> {
//! let plugin = get_openai_plugin()?;
//! let response = plugin.generate_text("Hello, world!").await?;
//! println!("{}", response);
//! # Ok(())
//! # }
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
pub use types::*;

use anyhow::Result as AnyhowResult;
use std::sync::Arc;

/// OpenAI plugin for elizaOS.
///
/// This struct wraps the OpenAI client and provides a simple interface
/// for text generation and other OpenAI API calls.
pub struct OpenAIPlugin {
    client: OpenAIClient,
}

impl OpenAIPlugin {
    /// Create a new OpenAIPlugin with the given configuration.
    pub fn new(config: OpenAIConfig) -> Result<Self> {
        let client = OpenAIClient::new(config)?;
        Ok(Self { client })
    }

    /// Generate text from a prompt.
    pub async fn generate_text(&self, prompt: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt);
        self.client.generate_text(&params).await
    }

    /// Generate text with a system message.
    pub async fn generate_text_with_system(&self, prompt: &str, system: &str) -> Result<String> {
        let params = TextGenerationParams::new(prompt).system(system);
        self.client.generate_text(&params).await
    }

    /// Generate text with full parameters.
    pub async fn generate_text_with_params(&self, params: &TextGenerationParams) -> Result<String> {
        self.client.generate_text(params).await
    }

    /// Create an embedding for text.
    pub async fn create_embedding(&self, text: &str) -> Result<Vec<f32>> {
        let params = EmbeddingParams::new(text);
        self.client.create_embedding(&params).await
    }

    /// Get the underlying client for advanced operations.
    pub fn client(&self) -> &OpenAIClient {
        &self.client
    }
}

/// Create an OpenAI plugin from environment variables.
///
/// Required environment variables:
/// - `OPENAI_API_KEY`: Your OpenAI API key
///
/// Optional environment variables:
/// - `OPENAI_BASE_URL`: Custom API endpoint (default: https://api.openai.com/v1)
/// - `OPENAI_SMALL_MODEL`: Model for small tasks (default: gpt-4o-mini)
/// - `OPENAI_LARGE_MODEL`: Model for large tasks (default: gpt-4o)
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

/// Create an elizaOS Plugin with model handlers for TEXT_LARGE, TEXT_SMALL, and TEXT_EMBEDDING.
///
/// This returns a Plugin that can be passed to AgentRuntime to register model handlers.
/// The plugin reads configuration from environment variables.
///
/// # Example
/// ```rust,ignore
/// use elizaos_plugin_openai::create_openai_elizaos_plugin;
/// use elizaos::runtime::{AgentRuntime, RuntimeOptions};
///
/// let plugin = create_openai_elizaos_plugin()?;
/// let runtime = AgentRuntime::new(RuntimeOptions {
///     plugins: vec![plugin],
///     ..Default::default()
/// }).await?;
/// ```
pub fn create_openai_elizaos_plugin() -> AnyhowResult<elizaos::types::Plugin> {
    use elizaos::types::{Plugin, PluginDefinition};
    use std::collections::HashMap;
    
    // Create the underlying OpenAI plugin
    let openai = Arc::new(get_openai_plugin()?);
    
    let mut model_handlers: HashMap<String, elizaos::types::ModelHandlerFn> = HashMap::new();
    
    // TEXT_LARGE handler
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
    
    // TEXT_SMALL handler
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
                
                // Use small model by setting it explicitly
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
