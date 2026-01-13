#![allow(missing_docs)]
//! elizaOS xAI Plugin
//!
//! This crate provides xAI Grok model support and Twitter API v2 integration
//! for elizaOS agents.
//!
//! # Features
//!
//! - xAI Grok models for text generation and embeddings
//! - Full Twitter API v2 client for X platform (posts, timelines, users, search)
//! - OAuth 1.0a and Bearer token authentication
//! - Async/await with Tokio runtime
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_xai::{GrokClient, GrokConfig, TwitterClient, TwitterConfig};
//! use elizaos_plugin_xai::grok::TextGenerationParams;
//!
//! # async fn example() -> anyhow::Result<()> {
//! // Grok client
//! let grok = GrokClient::new(GrokConfig::from_env()?)?;
//! let result = grok.generate_text(&TextGenerationParams::new("Hello"), false).await?;
//!
//! // X client
//! let mut x = TwitterClient::new(TwitterConfig::from_env()?)?;
//! let me = x.me().await?;
//! println!("Logged in as @{}", me.username);
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod actions;
pub mod client;
pub mod error;
pub mod grok;
pub mod models;
pub mod services;
pub mod types;

use anyhow::Result as AnyhowResult;
use std::collections::HashMap;
use std::sync::Arc;

// Re-export commonly used types
pub use crate::actions::{PostAction, PostActionResult};
pub use crate::client::TwitterClient;
pub use crate::grok::{EmbeddingParams, GrokClient, GrokConfig, TextGenerationParams};
pub use crate::models::{TextEmbeddingHandler, TextLargeHandler, TextSmallHandler};
pub use crate::types::TwitterConfig;
pub use crate::services::{XService, XServiceSettings};

/// Build a Twitter/X API client from environment configuration.
///
/// This reads [`TwitterConfig`] from the process environment and returns a ready-to-use
/// [`TwitterClient`].
pub fn get_x_client() -> AnyhowResult<TwitterClient> {
    let config = TwitterConfig::from_env()?;
    Ok(TwitterClient::new(config)?)
}

/// Build a Grok (xAI) client from environment configuration.
///
/// This reads [`GrokConfig`] from the process environment and returns a ready-to-use
/// [`GrokClient`].
pub fn get_grok_client() -> AnyhowResult<GrokClient> {
    let config = GrokConfig::from_env()?;
    Ok(GrokClient::new(config)?)
}

/// Create an elizaOS [`elizaos::types::Plugin`] wired to Grok model handlers.
///
/// This follows the same pattern as other Rust examples (e.g. OpenAI) and is
/// intended for use by example agents that construct an `AgentRuntime` from plugins.
///
/// Registered model handlers:
/// - `TEXT_SMALL`  -> Grok small model (default: `grok-3-mini`)
/// - `TEXT_LARGE`  -> Grok large model (default: `grok-3`)
/// - `TEXT_EMBEDDING` -> Grok embedding model (default: `grok-embedding`) returned as JSON array string
pub fn create_xai_elizaos_plugin() -> AnyhowResult<elizaos::types::Plugin> {
    use elizaos::types::{Plugin, PluginDefinition};

    let grok = Arc::new(get_grok_client()?);

    let mut model_handlers: HashMap<String, elizaos::types::ModelHandlerFn> = HashMap::new();

    // TEXT_SMALL
    let grok_small = Arc::clone(&grok);
    model_handlers.insert(
        "TEXT_SMALL".to_string(),
        Box::new(move |params: serde_json::Value| {
            let grok = Arc::clone(&grok_small);
            Box::pin(async move {
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing prompt"))?;

                let system = params.get("system").and_then(|v| v.as_str()).map(str::to_string);
                let temperature = params
                    .get("temperature")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.7) as f32;

                let max_tokens = params
                    .get("max_tokens")
                    .and_then(|v| v.as_u64())
                    .or_else(|| params.get("maxTokens").and_then(|v| v.as_u64()))
                    .map(|v| v as u32);

                let mut tg = TextGenerationParams::new(prompt.to_string()).temperature(temperature);
                if let Some(max) = max_tokens {
                    tg = tg.max_tokens(max);
                }
                if let Some(sys) = system {
                    tg = tg.system(sys);
                }

                let result = grok.generate_text(&tg, false).await?;
                Ok(result.text)
            })
        }),
    );

    // TEXT_LARGE
    let grok_large = Arc::clone(&grok);
    model_handlers.insert(
        "TEXT_LARGE".to_string(),
        Box::new(move |params: serde_json::Value| {
            let grok = Arc::clone(&grok_large);
            Box::pin(async move {
                let prompt = params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing prompt"))?;

                let system = params.get("system").and_then(|v| v.as_str()).map(str::to_string);
                let temperature = params
                    .get("temperature")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.7) as f32;

                let max_tokens = params
                    .get("max_tokens")
                    .and_then(|v| v.as_u64())
                    .or_else(|| params.get("maxTokens").and_then(|v| v.as_u64()))
                    .map(|v| v as u32);

                let mut tg = TextGenerationParams::new(prompt.to_string()).temperature(temperature);
                if let Some(max) = max_tokens {
                    tg = tg.max_tokens(max);
                }
                if let Some(sys) = system {
                    tg = tg.system(sys);
                }

                let result = grok.generate_text(&tg, true).await?;
                Ok(result.text)
            })
        }),
    );

    // TEXT_EMBEDDING
    let grok_embed = Arc::clone(&grok);
    model_handlers.insert(
        "TEXT_EMBEDDING".to_string(),
        Box::new(move |params: serde_json::Value| {
            let grok = Arc::clone(&grok_embed);
            Box::pin(async move {
                let text = params
                    .get("text")
                    .and_then(|v| v.as_str())
                    .or_else(|| params.get("input").and_then(|v| v.as_str()))
                    .ok_or_else(|| anyhow::anyhow!("Missing text"))?;

                let embedding = grok.create_embedding(&EmbeddingParams::new(text)).await?;
                let json = serde_json::to_string(&embedding)?;
                Ok(json)
            })
        }),
    );

    Ok(Plugin {
        definition: PluginDefinition {
            name: "xai".to_string(),
            description: "xAI Grok models and X (formerly Twitter) API integration".to_string(),
            ..Default::default()
        },
        model_handlers,
        ..Default::default()
    })
}

/// Start the X background service and register it with the runtime.
///
/// This reads `X_*` environment variables to configure polling and dry-run behavior.
pub async fn start_x_service(runtime: Arc<elizaos::AgentRuntime>) -> AnyhowResult<Arc<XService>> {
    let settings = XServiceSettings::from_env()?;
    let service = XService::start(Arc::clone(&runtime), settings).await?;
    let service_dyn: Arc<dyn elizaos::runtime::Service> = service.clone();
    runtime.register_service(XService::SERVICE_TYPE, service_dyn).await;
    Ok(service)
}
