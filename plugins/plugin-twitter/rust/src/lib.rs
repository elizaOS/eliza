//! elizaOS Twitter/X Plugin
//!
//! This crate provides Twitter API v2 integration and xAI (Grok) model support
//! for elizaOS agents.
//!
//! # Features
//!
//! - Full Twitter API v2 client (tweets, timelines, users, search)
//! - xAI (Grok) model integration for AI-powered content
//! - OAuth 1.0a and Bearer token authentication
//! - Async/await with Tokio runtime
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos_plugin_twitter::{TwitterClient, TwitterConfig};
//!
//! # async fn example() -> anyhow::Result<()> {
//! let config = TwitterConfig::from_env()?;
//! let client = TwitterClient::new(config)?;
//!
//! // Get authenticated user
//! let me = client.me().await?;
//! println!("Logged in as @{}", me.username);
//!
//! // Post a tweet
//! let result = client.post_tweet("Hello from elizaOS! 🤖").await?;
//! println!("Posted tweet: {}", result.id);
//! # Ok(())
//! # }
//! ```

#![warn(missing_docs)]

pub mod client;
pub mod error;
pub mod grok;
pub mod types;

pub use client::TwitterClient;
pub use error::{TwitterError, Result};
pub use grok::{GrokClient, GrokConfig};
pub use types::*;

use anyhow::Result as AnyhowResult;

/// Create a Twitter plugin from environment variables.
///
/// Required environment variables:
/// - `TWITTER_API_KEY`: Your Twitter API key
/// - `TWITTER_API_SECRET_KEY`: Your Twitter API secret
/// - `TWITTER_ACCESS_TOKEN`: Your access token
/// - `TWITTER_ACCESS_TOKEN_SECRET`: Your access token secret
///
/// Optional environment variables:
/// - `XAI_API_KEY`: xAI (Grok) API key for AI features
/// - `XAI_MODEL`: Grok model to use (default: grok-3)
pub fn get_twitter_plugin() -> AnyhowResult<TwitterClient> {
    let config = TwitterConfig::from_env()?;
    TwitterClient::new(config)
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
    GrokClient::new(config)
}

