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
pub mod types;

// Import directly from submodules:
// - actions::{PostAction, PostActionResult}
// - client::TwitterClient
// - error::{XAIError, Result}
// - grok::{GrokClient, GrokConfig, TextGenerationParams, EmbeddingParams}
// - models::{TextSmallHandler, TextLargeHandler, TextEmbeddingHandler}
// - types::* for all types

use anyhow::Result as AnyhowResult;

// Re-export commonly used types
pub use crate::actions::{PostAction, PostActionResult};
pub use crate::client::TwitterClient;
pub use crate::grok::{GrokClient, GrokConfig, TextGenerationParams, EmbeddingParams};
pub use crate::models::{TextSmallHandler, TextLargeHandler, TextEmbeddingHandler};
pub use crate::types::TwitterConfig;

/// Create a Twitter API client for X from environment variables.
///
/// Required environment variables:
/// - `X_API_KEY`: X API key
/// - `X_API_SECRET`: X API secret
/// - `X_ACCESS_TOKEN`: Access token
/// - `X_ACCESS_TOKEN_SECRET`: Access token secret
pub fn get_x_client() -> AnyhowResult<TwitterClient> {
    let config = TwitterConfig::from_env()?;
    Ok(TwitterClient::new(config)?)
}

/// Create a Grok client from environment variables.
///
/// Required environment variables:
/// - `XAI_API_KEY`: xAI API key
///
/// Optional environment variables:
/// - `XAI_BASE_URL`: Custom API endpoint (default: https://api.x.ai/v1)
/// - `XAI_MODEL`: Model to use (default: grok-3)
pub fn get_grok_client() -> AnyhowResult<GrokClient> {
    let config = GrokConfig::from_env()?;
    Ok(GrokClient::new(config)?)
}
