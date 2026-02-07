#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, PluginManagerError>;

#[derive(Error, Debug)]
pub enum PluginManagerError {
    #[error("Plugin not found: {0}")]
    PluginNotFound(String),

    #[error("Plugin already registered: {0}")]
    PluginAlreadyRegistered(String),

    #[error("Plugin not ready to load (status: {status}): {name}")]
    PluginNotReady { name: String, status: String },

    #[error("Plugin has no instance: {0}")]
    PluginNoInstance(String),

    #[error("Cannot modify protected plugin: {0}")]
    ProtectedPlugin(String),

    #[error("Cannot unload original plugin: {0}")]
    OriginalPlugin(String),

    #[error("Plugin requires configuration. Missing: {missing_keys}")]
    NeedsConfiguration { missing_keys: String },

    #[error("Installation failed for {plugin_name}: {reason}")]
    InstallationFailed {
        plugin_name: String,
        reason: String,
    },

    #[error("Registry fetch failed: {0}")]
    RegistryFetchFailed(String),

    #[error("API error (status {status}): {message}")]
    Api { status: u16, message: String },

    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("JSON parsing error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),
}
