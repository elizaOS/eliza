//! elizaOS Plugin BlueSky - Rust Implementation
//!
//! This crate provides a BlueSky AT Protocol API client for elizaOS,
//! supporting posting, direct messaging, notifications, and profile management.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_bluesky::{BlueSkyClient, BlueSkyConfig, CreatePostRequest};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = BlueSkyConfig::from_env()?;
//!     let client = BlueSkyClient::new(config)?;
//!
//!     // Authenticate
//!     client.authenticate().await?;
//!
//!     // Create a post
//!     let request = CreatePostRequest::new("Hello from Rust!");
//!     let post = client.send_post(request).await?;
//!     println!("Created post: {}", post.uri);
//!
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export main types
pub use client::BlueSkyClient;
pub use config::BlueSkyConfig;
pub use error::{BlueSkyError, Result};
pub use types::{
    BlueSkyConversation, BlueSkyMessage, BlueSkyNotification, BlueSkyPost, BlueSkyProfile,
    BlueSkySession, CreatePostRequest, NotificationReason, SendMessageRequest, TimelineRequest,
    TimelineResponse,
};

/// Create a BlueSky client from environment variables.
///
/// # Errors
///
/// Returns an error if required environment variables are not set.
pub fn create_client_from_env() -> Result<BlueSkyClient> {
    let config = BlueSkyConfig::from_env()?;
    BlueSkyClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "bluesky";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "BlueSky AT Protocol client with posting, messaging, and notification support";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

