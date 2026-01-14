#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::OpenRouterClient;
pub use config::OpenRouterConfig;
pub use error::{OpenRouterError, Result};
pub use types::{
    EmbeddingParams, EmbeddingResponse, ObjectGenerationParams, ObjectGenerationResponse,
    TextGenerationParams, TextGenerationResponse,
};

pub fn create_client_from_env() -> Result<OpenRouterClient> {
    let config = OpenRouterConfig::from_env()?;
    OpenRouterClient::new(config)
}

pub const PLUGIN_NAME: &str = "openrouter";
pub const PLUGIN_DESCRIPTION: &str =
    "OpenRouter multi-model AI gateway with text, object generation, and embedding support";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
