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

// Re-export commonly used types
pub use crate::actions::{PostAction, PostActionResult};
pub use crate::client::TwitterClient;
pub use crate::grok::{EmbeddingParams, GrokClient, GrokConfig, TextGenerationParams};
pub use crate::models::{TextEmbeddingHandler, TextLargeHandler, TextSmallHandler};
pub use crate::types::TwitterConfig;

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
