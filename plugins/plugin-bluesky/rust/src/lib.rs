#![allow(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::BlueSkyClient;
pub use config::BlueSkyConfig;
pub use error::{BlueSkyError, Result};
pub use service::BlueSkyService;
pub use types::{CreatePostRequest, PostReference, TimelineRequest};

pub fn create_client_from_env() -> Result<BlueSkyClient> {
    let config = BlueSkyConfig::from_env()?;
    BlueSkyClient::new(config)
}

pub const PLUGIN_NAME: &str = "bluesky";
pub const PLUGIN_DESCRIPTION: &str =
    "BlueSky AT Protocol client with posting, messaging, and notification support";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
