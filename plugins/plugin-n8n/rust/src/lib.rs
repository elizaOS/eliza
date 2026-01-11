#![allow(missing_docs)]
//! elizaOS N8n Plugin - Rust Implementation
//!
//! This crate provides an AI-powered plugin creation system for elizaOS,
//! using Anthropic's Claude models for code generation.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_n8n::{PluginCreationClient, N8nConfig, PluginSpecification};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = N8nConfig::from_env()?;
//!     let client = PluginCreationClient::new(config)?;
//!
//!     let spec = PluginSpecification::builder()
//!         .name("@elizaos/plugin-weather")
//!         .description("Weather information plugin")
//!         .build()?;
//!
//!     let job_id = client.create_plugin(spec, None).await?;
//!     println!("Job started: {}", job_id);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod models;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export main types
pub use client::PluginCreationClient;
pub use config::N8nConfig;
pub use error::{N8nError, Result};
pub use models::{ClaudeModel, JobStatus};
pub use types::{
    ActionSpecification, CreatePluginOptions, EnvironmentVariableSpec, EvaluatorSpecification,
    JobError, PluginCreationJob, PluginRegistryData, PluginSpecification, ProviderSpecification,
    ServiceSpecification, TestResults,
};

/// Create a plugin creation client from environment variables.
///
/// # Errors
///
/// Returns an error if ANTHROPIC_API_KEY is not set.
pub fn create_client_from_env() -> Result<PluginCreationClient> {
    let config = N8nConfig::from_env()?;
    PluginCreationClient::new(config)
}

/// Plugin metadata
pub const PLUGIN_NAME: &str = "n8n";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "AI-powered plugin creation for elizaOS using Claude models";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");







