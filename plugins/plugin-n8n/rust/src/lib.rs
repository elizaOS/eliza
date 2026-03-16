//! N8n plugin for elizaOS.
//!
//! This crate provides AI-powered plugin creation capabilities for elizaOS using Claude models.
//! It enables automated plugin generation, status tracking, and plugin registry management
//! through integration with n8n workflows.

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Actions for n8n plugin creation and management.
pub mod actions;
pub mod client;
pub mod config;
pub mod error;
pub mod models;
/// Providers for n8n plugin status and capabilities information.
pub mod providers;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::PluginCreationClient;
pub use config::N8nConfig;
pub use error::{N8nError, Result};
pub use models::{ClaudeModel, JobStatus};
pub use service::{PluginCreationService, PLUGIN_CREATION_SERVICE_TYPE};
pub use types::PluginSpecification;

pub use actions::{
    ActionContext, ActionResult, CancelPluginAction, CheckStatusAction,
    CreateFromDescriptionAction, CreatePluginAction, N8nAction,
};

pub use providers::{
    N8nProvider, PluginCreationCapabilitiesProvider, PluginCreationStatusProvider,
    PluginExistsProvider, PluginRegistryProvider, ProviderContext, ProviderResult,
};

/// Creates a new plugin creation client using configuration from environment variables.
///
/// This is a convenience function that reads the n8n configuration from environment
/// variables and initializes a [`PluginCreationClient`].
///
/// # Errors
///
/// Returns an error if the configuration cannot be read from environment variables
/// or if the client initialization fails.
pub fn create_client_from_env() -> Result<PluginCreationClient> {
    let config = N8nConfig::from_env()?;
    PluginCreationClient::new(config)
}

/// The name identifier for the n8n plugin.
pub const PLUGIN_NAME: &str = "n8n";

/// A human-readable description of the n8n plugin's purpose.
pub const PLUGIN_DESCRIPTION: &str = "Plugin creation for elizaOS";

/// The current version of the n8n plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
